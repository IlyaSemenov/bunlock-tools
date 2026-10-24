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
import { getCatalogs } from "./manifest"
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
 * The nested root workspace is dropped, because it is not a workspace of the host.
 */
export function relocateLockfile(lock: Lockfile, dir: string): Lockfile {
  return {
    ...lock,
    workspaces: Object.fromEntries(
      Object.entries(lock.workspaces)
        .filter(([workspacePath]) => workspacePath)
        .map(([workspacePath, workspace]) => [path.posix.join(dir, workspacePath), workspace]),
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
 */
export function applyManifestToLockfile(lock: Lockfile, manifest: PackageManifest): Lockfile {
  const { catalog, catalogs } = getCatalogs(manifest)
  const fields: Pick<BunLockFile, "catalog" | "catalogs" | "overrides" | "patchedDependencies"> = {
    catalog,
    catalogs,
    overrides: manifest.overrides,
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
 * A host workspace without a name cannot have nested entries, so `bun install` resolves its dependency again.
 * When the previous host resolution does not satisfy the range either, which Bun lockfiles occasionally contain,
 * the dependency gets the highest satisfying version recorded in either lockfile.
 * Catalog dependencies are checked against the catalogs of the host lockfile, so apply the synced root fields
 * to it first.
 */
export function mergeLockfiles(lock: Lockfile, nestedLock: Lockfile, dir: string): Lockfile {
  // Nested chains under packages that the nested lockfile resolves are taken from the nested lockfile only.
  const hostPackages = Object.entries(lock.packages).filter(
    ([key]) => !(splitPackageKey(key)[0]! in nestedLock.packages),
  )
  const packages = { ...Object.fromEntries(hostPackages), ...nestedLock.packages }
  // Workspaces inside the nested directory come from the nested lockfile only, including removed ones.
  const hostWorkspaces = Object.entries(lock.workspaces).filter(
    ([workspacePath]) => !isNestedPath(workspacePath, dir),
  )
  const dependents = [
    ...hostWorkspaces.map(([, workspace]) => ({
      key: workspace.name,
      dependencies: getWorkspaceDependencies(workspace),
    })),
    ...Object.keys(packages).map(key => ({
      key,
      dependencies: getPackageDependencies(packages[key]!),
    })),
  ]

  for (let index = 0; index < dependents.length; index++) {
    const { key, dependencies } = dependents[index]!
    if (key === undefined) {
      continue
    }

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
