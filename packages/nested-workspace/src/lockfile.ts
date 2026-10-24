import path from "node:path"

import type {
  BunLockFile,
  BunLockWorkspace,
  BunPackageEntry,
  DependencyMap,
} from "bunlock-lockfile"
import {
  dependencyRequirement,
  effectiveDependencyRange,
  packageEntryMeta,
  parseBunLock,
  parseResolvedSpec,
  resolveDependencyLockKey,
} from "bunlock-lockfile"

import { getErrorMessage } from "./errors"
import type { PackageManifest } from "./manifest"
import { getCatalogs, resolveOverrideValue } from "./manifest"
import { isNestedPath } from "./paths"

/** Parsed `bun.lock` with a supported `lockfileVersion`. */
export type Lockfile = BunLockFile & {
  lockfileVersion: number
  workspaces: Record<string, BunLockWorkspace>
  packages: Record<string, BunPackageEntry>
}

/**
 * `bun.lock` format versions this package understands.
 *
 * The format is internal to Bun, so other versions are rejected instead of being rewritten blindly.
 */
export const supportedLockfileVersions: readonly number[] = [1, 2]

/** Parses `bun.lock` text and rejects lockfile versions outside `supportedLockfileVersions`. */
export function parseLockfile(text: string, source = "bun.lock"): Lockfile {
  let lock: BunLockFile
  try {
    lock = parseBunLock(text)
  } catch (error) {
    throw new Error(`${source}: ${getErrorMessage(error)}`, { cause: error })
  }
  if (!supportedLockfileVersions.includes(lock.lockfileVersion!)) {
    throw new Error(
      `${source} has lockfileVersion ${lock.lockfileVersion}, supported versions: ${supportedLockfileVersions.join(", ")}`,
    )
  }
  return { ...lock, workspaces: lock.workspaces ?? {}, packages: lock.packages ?? {} } as Lockfile
}

/** Reads and parses a `bun.lock` file. */
export async function readLockfile(file: string): Promise<Lockfile> {
  return parseLockfile(await Bun.file(file).text(), file)
}

/**
 * Returns the nested lockfile with workspace and local paths relative to the host root.
 *
 * The nested root workspace moves to the nested directory, where it is a workspace of the host,
 * and takes `rootName`, the name of the nested root `package.json`, when it is given.
 * Bun requires the name of a workspace package entry but keeps a root entry without the name
 * when the name was added to `package.json` after the lockfile.
 */
export function relocateLockfile(lock: Lockfile, dir: string, rootName?: string): Lockfile {
  return {
    ...lock,
    workspaces: Object.fromEntries(
      Object.entries(lock.workspaces).map(([workspacePath, workspace]) => [
        path.posix.join(dir, workspacePath),
        workspacePath === "" && rootName !== undefined
          ? { ...workspace, name: rootName }
          : workspace,
      ]),
    ),
    packages: Object.fromEntries(
      Object.entries(lock.packages).map(([key, [resolution, ...rest]]) => [
        key,
        [relocateResolution(resolution, dir), ...rest] as BunPackageEntry,
      ]),
    ),
  }
}

/** Rewrites a root-relative `workspace:`, `file:` or `link:` resolution through the nested directory. */
function relocateResolution(resolution: string, dir: string) {
  const match = /^((?:@[^/]+\/)?[^@]+)@(workspace|file|link):(.*)$/.exec(resolution)
  if (!match) {
    return resolution
  }

  const [, name, protocol, target] = match as unknown as [string, string, string, string]
  if (path.posix.isAbsolute(target)) {
    return resolution
  }

  const relocated = path.posix.join(dir, target)
  return `${name}@${protocol}:${target.startsWith("./") ? `./${relocated}` : relocated}`
}

/**
 * Returns the lockfile with root fields that affect resolution taken from the root `package.json`.
 *
 * `bun install` re-resolves dependencies whose catalog entry, override, or patch differs from the lockfile,
 * so the merged lockfile must already record the synced root fields to keep the nested resolutions.
 * Records `$name` overrides with the range they refer to, as Bun does, and throws when `resolveOverrideValue` does.
 */
export function applyManifestToLockfile(lock: Lockfile, manifest: PackageManifest): Lockfile {
  const { catalog, catalogs } = getCatalogs(manifest)
  const overrides =
    manifest.overrides &&
    Object.fromEntries(
      Object.entries(manifest.overrides).map(([name, value]) => [
        name,
        resolveOverrideValue(manifest, name, value),
      ]),
    )
  const fields: Pick<BunLockFile, "catalog" | "catalogs" | "overrides" | "patchedDependencies"> = {
    catalog,
    catalogs,
    overrides,
    patchedDependencies: manifest.patchedDependencies,
  }

  const result: Lockfile = { ...lock }
  for (const [field, value] of Object.entries(fields) as [keyof typeof fields, object?][]) {
    if (value && Object.keys(value).length) {
      Object.assign(result, { [field]: value })
    } else {
      delete result[field]
    }
  }
  return result
}

/**
 * Merges the host lockfile with the relocated nested lockfile.
 *
 * Nested entries override host entries, so the nested packages keep the versions of the nested lockfile.
 * A root entry overridden by the nested lockfile might not satisfy a dependency of a host package:
 * such a dependency gets back its previous host resolution as a nested entry, so `bun install` keeps the host version
 * instead of resolving the range again.
 * A dependency of the host root package gets it back at the top level instead, as `keepHostRootResolutions` describes.
 * A host workspace other than the root without a name cannot have nested entries,
 * so `bun install` resolves its dependency again.
 * When the previous host resolution does not satisfy the range either, which Bun lockfiles occasionally contain,
 * the dependency gets the highest satisfying version recorded in either lockfile.
 * Catalog dependencies are checked against the catalogs of the host lockfile, so apply the synced root fields
 * to it first.
 */
export function mergeLockfiles(lock: Lockfile, nestedLock: Lockfile, dir: string): Lockfile {
  // Nested chains under packages that the nested lockfile resolves are taken from the nested lockfile only.
  // The nested workspaces count among them: the nested lockfile has no package entry for its root.
  const nestedNames = new Set([
    ...Object.keys(nestedLock.packages),
    ...Object.values(nestedLock.workspaces).flatMap(workspace => workspace.name ?? []),
  ])
  const hostPackages = Object.entries(lock.packages).filter(
    ([key]) => !nestedNames.has(splitPackageKey(key)[0]!),
  )
  const packages = { ...Object.fromEntries(hostPackages), ...nestedLock.packages }
  // Workspaces inside the nested directory come from the nested lockfile only, including removed ones.
  const hostWorkspaces = Object.entries(lock.workspaces).filter(
    ([workspacePath]) => !isNestedPath(workspacePath, dir),
  )
  const hostRoot = lock.workspaces[""]
  if (hostRoot) {
    keepHostRootResolutions(lock, nestedLock, packages)
  }

  const dependents = [
    ...hostWorkspaces.flatMap(([workspacePath, workspace]) =>
      workspacePath && workspace.name
        ? [{ key: workspace.name, dependencies: getWorkspaceDependencies(workspace) }]
        : [],
    ),
    ...Object.keys(packages).map(key => ({
      key,
      dependencies: getPackageDependencies(packages[key]!),
    })),
  ]

  for (let index = 0; index < dependents.length; index++) {
    const { key, dependencies } = dependents[index]!
    for (const [dependency, specifier] of Object.entries(dependencies)) {
      const requirement = getRequirement(lock, dependency, specifier)
      const resolved = resolveDependencyLockKey(key, dependency, packages)
      if (!requirement || !resolved || satisfies(packages[resolved]!, requirement)) {
        continue
      }

      const previous = resolveDependencyLockKey(key, dependency, lock.packages)
      const replacement =
        previous && satisfies(lock.packages[previous]!, requirement)
          ? lock.packages[previous]!
          : findSatisfyingEntry([packages, lock.packages], requirement)
      if (!replacement) {
        continue
      }

      const nestedKey = `${key}/${dependency}`
      packages[nestedKey] = replacement
      dependents.push({ key: nestedKey, dependencies: getPackageDependencies(replacement) })
    }
  }

  return {
    ...lock,
    lockfileVersion: Math.max(lock.lockfileVersion, nestedLock.lockfileVersion),
    workspaces: { ...Object.fromEntries(hostWorkspaces), ...nestedLock.workspaces },
    packages,
  }
}

/**
 * Gives the dependencies of the host root package back their previous host resolutions where top-level nested
 * entries do not satisfy them.
 *
 * Bun resolves the dependencies of the root package at the top level only, so placing the host resolution under the
 * root name does not pin the root dependency: the host resolution returns to the top level with its host chain instead.
 * Then every dependency of a nested workspace or package that no longer resolves to its nested entry or a copy of it,
 * such as one that resolved the replaced entry, gets a copy of its nested entry under the dependent,
 * so the copied entries keep their whole nested dependency trees.
 */
function keepHostRootResolutions(
  lock: Lockfile,
  nestedLock: Lockfile,
  packages: Lockfile["packages"],
) {
  const replaced = new Set<string>()
  for (const [dependency, specifier] of Object.entries(
    getWorkspaceDependencies(lock.workspaces[""]!),
  )) {
    const requirement = getRequirement(lock, dependency, specifier)
    const nestedEntry = Object.hasOwn(nestedLock.packages, dependency)
      ? nestedLock.packages[dependency]
      : undefined
    if (!requirement || !nestedEntry || satisfies(nestedEntry, requirement)) {
      continue
    }

    const previous = Object.hasOwn(lock.packages, dependency)
      ? lock.packages[dependency]
      : undefined
    const replacement =
      previous && satisfies(previous, requirement)
        ? previous
        : findSatisfyingEntry([nestedLock.packages, lock.packages], requirement)
    if (!replacement) {
      continue
    }

    replaced.add(dependency)
    // The nested chain under the replaced entry belongs to the nested entry, which moves under its dependents below.
    const prefix = `${dependency}/`
    for (const key of Object.keys(packages)) {
      if (key.startsWith(prefix)) {
        delete packages[key]
      }
    }
    packages[dependency] = replacement
    if (replacement === previous) {
      for (const [key, entry] of Object.entries(lock.packages)) {
        if (key.startsWith(prefix)) {
          packages[key] = entry
        }
      }
    }
  }
  if (!replaced.size) {
    return
  }

  // Nested lockfile keys of the merged entries that come from the nested lockfile, including the ones pinned below.
  const nestedKeys = new Map(
    Object.keys(nestedLock.packages)
      .filter(key => !replaced.has(splitPackageKey(key)[0]!))
      .map(key => [key, key]),
  )
  // Each item pairs a dependent in the merged lockfile with its key in the nested lockfile.
  const queue = [
    ...Object.values(nestedLock.workspaces).flatMap(workspace =>
      workspace.name
        ? [
            {
              key: workspace.name,
              nestedKey: workspace.name,
              dependencies: getWorkspaceDependencies(workspace),
            },
          ]
        : [],
    ),
    ...[...nestedKeys.keys()].map(key => ({
      key,
      nestedKey: key,
      dependencies: getPackageDependencies(nestedLock.packages[key]!),
    })),
  ]
  for (let index = 0; index < queue.length; index++) {
    const { key, nestedKey, dependencies } = queue[index]!
    for (const dependency of Object.keys(dependencies)) {
      const expected = resolveDependencyLockKey(nestedKey, dependency, nestedLock.packages)
      if (expected === undefined) {
        continue
      }
      // Another entry of the same version may resolve its own dependencies differently, so only a copy of the
      // nested entry, whose dependencies the queue checks, keeps the nested resolution.
      const actual = resolveDependencyLockKey(key, dependency, packages)
      if (actual !== undefined && nestedKeys.get(actual) === expected) {
        continue
      }

      const entry = nestedLock.packages[expected]!
      const pinnedKey = `${key}/${dependency}`
      packages[pinnedKey] = entry
      nestedKeys.set(pinnedKey, expected)
      queue.push({
        key: pinnedKey,
        nestedKey: expected,
        dependencies: getPackageDependencies(entry),
      })
    }
  }
}

/** Returns the installed dependencies declared by a lockfile workspace. */
export function getWorkspaceDependencies(workspace: BunLockWorkspace): DependencyMap {
  return {
    ...workspace.dependencies,
    ...workspace.devDependencies,
    ...workspace.optionalDependencies,
  }
}

/** Returns the dependencies declared by a lockfile package entry. */
export function getPackageDependencies(entry: BunPackageEntry): DependencyMap {
  const metadata = packageEntryMeta(entry)
  return { ...metadata?.dependencies, ...metadata?.optionalDependencies }
}

/** Package and version range that a dependency requires. */
interface Requirement {
  name: string
  range: string
}

/**
 * Returns the package and version range that a dependency specifier requires.
 *
 * An override replaces the specifier, as `bun install` applies it to direct and transitive dependencies alike.
 * Returns `undefined` for specifiers that do not resolve by version, such as `workspace:` or git URLs.
 */
function getRequirement(
  lock: Lockfile,
  dependency: string,
  specifier: string,
): Requirement | undefined {
  return parseRequirement(lock, dependency, effectiveDependencyRange(lock, dependency, specifier))
}

/** Resolves `catalog:` specifiers and `npm:` aliases of `getRequirement`. */
function parseRequirement(
  lock: Lockfile,
  dependency: string,
  specifier: string,
): Requirement | undefined {
  if (specifier.startsWith("catalog:")) {
    const catalogName = specifier.slice("catalog:".length)
    const catalog =
      catalogName && catalogName !== "default" ? lock.catalogs?.[catalogName] : lock.catalog
    const range = catalog?.[dependency]
    return range === undefined ? undefined : parseRequirement(lock, dependency, range)
  }
  const requirement = dependencyRequirement(dependency, specifier)
  return /^[a-z+]+:|\//i.test(requirement.range) ? undefined : requirement
}

/** Returns the entry with the highest version of the required package that satisfies its range. */
function findSatisfyingEntry(
  sources: Lockfile["packages"][],
  requirement: Requirement,
): BunPackageEntry | undefined {
  let best: BunPackageEntry | undefined
  for (const entry of sources.flatMap(packages => Object.values(packages))) {
    if (
      satisfies(entry, requirement) &&
      (!best || Bun.semver.order(getVersion(entry)!, getVersion(best)!) > 0)
    ) {
      best = entry
    }
  }
  return best
}

function getVersion([resolution]: BunPackageEntry) {
  return parseResolvedSpec(resolution)?.version
}

/** Returns whether an entry resolves the required package to a version in its range. */
function satisfies(entry: BunPackageEntry, requirement: Requirement) {
  const spec = parseResolvedSpec(entry[0])
  return spec?.name === requirement.name && Bun.semver.satisfies(spec.version, requirement.range)
}

/**
 * Returns whether a lockfile entry satisfies the specifier of a dependency on it.
 *
 * Specifiers that do not resolve by version, such as `workspace:` or git URLs, are always satisfied.
 */
export function satisfiesSpecifier(
  lock: Lockfile,
  dependency: string,
  specifier: string,
  entry: BunPackageEntry,
): boolean {
  const requirement = getRequirement(lock, dependency, specifier)
  return requirement === undefined || satisfies(entry, requirement)
}

/** Splits a lockfile package key into the package names of its nesting chain. */
function splitPackageKey(key: string) {
  return key.match(/(?:@[^/]+\/)?[^/]+/g) ?? []
}

/**
 * Returns the key of the entry that resolves a direct dependency of a workspace package.
 *
 * Bun nests workspace-specific entries under the workspace name, so a workspace without a name resolves at the root only.
 */
export function resolveWorkspaceDependencyKey(
  packages: Lockfile["packages"],
  workspaceName: string | undefined,
  dependency: string,
): string | undefined {
  if (workspaceName) {
    return resolveDependencyLockKey(workspaceName, dependency, packages)
  }
  return Object.hasOwn(packages, dependency) ? dependency : undefined
}

/** Returns the resolution of a direct dependency of a workspace package, such as `name@1.2.3`. */
export function resolveDependency(
  lock: Lockfile,
  workspaceName: string | undefined,
  dependency: string,
): string | undefined {
  const key = resolveWorkspaceDependencyKey(lock.packages, workspaceName, dependency)
  return key === undefined ? undefined : lock.packages[key]![0]
}
