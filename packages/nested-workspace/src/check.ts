import path from "node:path"

import type { BunPackageEntry } from "bunlock-lockfile"
import {
  packageOverrideRequester,
  resolveDependencyLockKey,
  workspaceOverrideRequester,
} from "bunlock-lockfile"

import type { Lockfile } from "./lockfile"
import {
  getPackageDependencies,
  getWorkspaceDependencies,
  resolveDependency,
  resolveWorkspaceDependencyKey,
  satisfiesSpecifier,
} from "./lockfile"
import type { PackageManifest } from "./manifest"
import { isNestedPath } from "./paths"

/** Dependency of a workspace package resolved differently than expected. */
export interface DependencyMismatch {
  /** Workspace package name, or its path when the package has no name. */
  workspace: string
  dependency: string
  /** Expected resolution, such as `name@1.2.3`; `undefined` when the dependency must not resolve. */
  expected?: string
  /** Actual resolution; `undefined` when the dependency does not resolve. */
  actual?: string
}

/** Transitive dependency resolved differently than expected. */
export interface PackageMismatch {
  /** Dependency chain from the nested workspace package, such as `["@nested/web", "nuxt", "@nuxt/kit"]`. */
  path: string[]
  /** Expected resolution, such as `name@1.2.3`. */
  expected: string
  /** Actual resolution; `undefined` when the dependency does not resolve. */
  actual?: string
}

/** `workspaces` patterns of a root `package.json`, without the leading `./`, the trailing slash, and the `!` of exclusions. */
export interface WorkspacePatterns {
  included: string[]
  excluded: string[]
}

/** Returns the `workspaces` patterns of a root `package.json`. */
export function getWorkspacePatterns(manifest: PackageManifest): WorkspacePatterns {
  const patterns = (
    Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? [])
  ).map(pattern => pattern.replace(/^(!?)\.\//, "$1").replace(/\/+$/, ""))
  return {
    included: patterns.filter(pattern => !pattern.startsWith("!")),
    excluded: patterns.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1)),
  }
}

/**
 * Returns whether the patterns include a directory relative to their root, as `bun install` decides it.
 *
 * The root itself is never included.
 * A pattern without glob syntax includes its exact path regardless of exclusions.
 * A glob pattern matches the `package.json` path of the directory, so `dir/**` includes `dir` itself,
 * and skips `node_modules`, `.git`, and `CMakeFiles` directories.
 * An exclusion `dir/**` also excludes `dir` itself.
 */
export function matchesWorkspacePatterns(patterns: WorkspacePatterns, dir: string): boolean {
  const isGlob = (pattern: string) => /[*?[\]{}]/.test(pattern)
  const matches = (pattern: string) => new Bun.Glob(pattern).match(dir)
  const matchesManifest = (pattern: string) =>
    new Bun.Glob(path.posix.join(pattern, "package.json")).match(
      path.posix.join(dir, "package.json"),
    )

  if (path.posix.normalize(dir) === ".") {
    return false
  }
  if (
    patterns.included.some(pattern => !isGlob(pattern) && path.posix.normalize(pattern) === dir)
  ) {
    return true
  }
  return (
    !dir.split("/").some(part => ignoredGlobDirs.has(part)) &&
    patterns.included.some(pattern => isGlob(pattern) && matchesManifest(pattern)) &&
    !patterns.excluded.some(
      pattern => matches(pattern) || (pattern.endsWith("/**") && matches(pattern.slice(0, -3))),
    )
  )
}

const ignoredGlobDirs = new Set(["node_modules", ".git", "CMakeFiles"])

/** Returns the nested workspace paths that the host `workspaces` patterns do not include. */
export function findUncoveredWorkspaces(manifest: PackageManifest, nestedLock: Lockfile): string[] {
  const patterns = getWorkspacePatterns(manifest)
  return Object.keys(nestedLock.workspaces).filter(
    workspacePath => !matchesWorkspacePatterns(patterns, workspacePath),
  )
}

/**
 * Returns the paths of nested workspaces whose host lockfile entries differ from the relocated nested lockfile,
 * including host entries of workspaces that the nested repository no longer has.
 */
export function findWorkspaceMismatches(
  lock: Lockfile,
  nestedLock: Lockfile,
  dir: string,
): string[] {
  const paths = new Set([
    ...Object.keys(nestedLock.workspaces),
    ...Object.keys(lock.workspaces).filter(workspacePath => isNestedPath(workspacePath, dir)),
  ])

  // Bun records the version and bin of a workspace package but not of the root, so the nested root entry lacks them.
  const comparable = (workspacePath: string, workspace: object | undefined) =>
    workspacePath === dir && workspace
      ? Object.fromEntries(
          Object.entries(workspace).filter(([key]) => key !== "version" && key !== "bin"),
        )
      : workspace

  return [...paths]
    .sort()
    .filter(
      workspacePath =>
        toCanonicalJson(comparable(workspacePath, lock.workspaces[workspacePath])) !==
        toCanonicalJson(comparable(workspacePath, nestedLock.workspaces[workspacePath])),
    )
}

/**
 * Returns the direct dependencies of nested workspaces that the host lockfile resolves differently than the nested one.
 *
 * Entries are compared like `findTransitiveMismatches` compares them, so a different integrity is a mismatch too.
 */
export function findDirectDependencyMismatches(
  lock: Lockfile,
  nestedLock: Lockfile,
): DependencyMismatch[] {
  return Object.entries(nestedLock.workspaces).flatMap(([workspacePath, workspace]) =>
    Object.keys(getWorkspaceDependencies(workspace)).flatMap(dependency => {
      const expected = getWorkspaceDependencyEntry(nestedLock, workspace.name, dependency)
      const actual = getWorkspaceDependencyEntry(lock, workspace.name, dependency)
      if (expected === undefined ? actual === undefined : isSameResolution(expected, actual)) {
        return []
      }
      return [
        {
          workspace: workspace.name ?? workspacePath,
          dependency,
          expected: expected?.[0],
          actual: actual?.[0],
        },
      ]
    }),
  )
}

/**
 * Returns the transitive dependencies of nested workspaces that the host lockfile resolves differently than the nested one.
 *
 * Walks the dependency edges from the nested workspaces through both lockfiles at once,
 * so a different hoisting layout of the same versions is not a mismatch.
 * Direct dependencies are covered by `findDirectDependencyMismatches`, and peer dependencies are not walked.
 * Edges that the nested lockfile resolves outside their range are skipped, because the merge repairs them.
 * Each mismatch is reported once, with the first dependency chain that reaches it, and its subtree is skipped.
 */
export function findTransitiveMismatches(lock: Lockfile, nestedLock: Lockfile): PackageMismatch[] {
  const queue: { path: string[]; nestedKey: string; hostKey: string }[] = []
  for (const [workspacePath, workspace] of Object.entries(nestedLock.workspaces)) {
    for (const dependency of Object.keys(getWorkspaceDependencies(workspace))) {
      const nestedKey = resolveWorkspaceDependencyKey(
        nestedLock.packages,
        workspace.name,
        dependency,
      )
      const hostKey = resolveWorkspaceDependencyKey(lock.packages, workspace.name, dependency)
      if (
        nestedKey &&
        hostKey &&
        isSameResolution(nestedLock.packages[nestedKey]!, lock.packages[hostKey])
      ) {
        queue.push({ path: [workspace.name ?? workspacePath, dependency], nestedKey, hostKey })
      }
    }
  }

  const visited = new Set<string>()
  const mismatches: PackageMismatch[] = []
  for (let index = 0; index < queue.length; index++) {
    const { path, nestedKey, hostKey } = queue[index]!
    const entry = nestedLock.packages[nestedKey]!
    // Workspace packages are checked as workspaces.
    if (entry[0].includes("@workspace:")) {
      continue
    }

    const requester = packageOverrideRequester(nestedLock, entry[0])
    for (const [dependency, specifier] of Object.entries(getPackageDependencies(entry))) {
      const nestedDependencyKey = resolveDependencyLockKey(
        nestedKey,
        dependency,
        nestedLock.packages,
      )
      // Bun leaves out optional dependencies that do not install, such as those for other platforms.
      // An edge that the nested lockfile itself resolves outside the range is repaired by the merge.
      if (
        !nestedDependencyKey ||
        !satisfiesSpecifier(
          nestedLock,
          requester,
          dependency,
          specifier,
          nestedLock.packages[nestedDependencyKey]!,
        )
      ) {
        continue
      }

      const hostDependencyKey = resolveDependencyLockKey(hostKey, dependency, lock.packages)
      const pair = `${nestedDependencyKey}\0${hostDependencyKey}`
      if (visited.has(pair)) {
        continue
      }
      visited.add(pair)

      const expected = nestedLock.packages[nestedDependencyKey]!
      const actual = hostDependencyKey === undefined ? undefined : lock.packages[hostDependencyKey]
      if (hostDependencyKey === undefined || !isSameResolution(expected, actual)) {
        mismatches.push({ path: [...path, dependency], expected: expected[0], actual: actual?.[0] })
        continue
      }
      queue.push({
        path: [...path, dependency],
        nestedKey: nestedDependencyKey,
        hostKey: hostDependencyKey,
      })
    }
  }

  return mismatches
}

/**
 * Returns the external direct dependencies of host workspaces whose resolution differs between two host lockfiles.
 *
 * A dependency that changed to the root resolution of the nested lockfile is not reported, because the nested versions win,
 * unless that resolution does not satisfy the host range.
 */
export function findOwnDependencyChanges(
  before: Lockfile,
  after: Lockfile,
  nestedLock: Lockfile,
  dir: string,
): DependencyMismatch[] {
  const workspaces = new Map(
    [...Object.entries(before.workspaces), ...Object.entries(after.workspaces)].filter(
      ([workspacePath]) => !isNestedPath(workspacePath, dir),
    ),
  )

  return [...workspaces].flatMap(([workspacePath, workspace]) => {
    const requester = workspaceOverrideRequester(
      Object.hasOwn(after.workspaces, workspacePath) ? after : before,
      workspacePath,
    )
    const specifiers = {
      ...getWorkspaceDependencies(before.workspaces[workspacePath] ?? {}),
      ...getWorkspaceDependencies(after.workspaces[workspacePath] ?? {}),
    }

    return Object.entries(specifiers).flatMap(([dependency, specifier]) => {
      if (specifier.startsWith("workspace:")) {
        return []
      }
      const expected = resolveDependency(before, workspace.name, dependency)
      const actual = resolveDependency(after, workspace.name, dependency)
      const nestedEntry = nestedLock.packages[dependency]
      if (
        actual === expected ||
        (actual !== undefined &&
          actual === nestedEntry?.[0] &&
          satisfiesSpecifier(after, requester, dependency, specifier, nestedEntry))
      ) {
        return []
      }
      return [{ workspace: workspace.name ?? workspacePath, dependency, expected, actual }]
    })
  })
}

/** Returns the entry that resolves a direct dependency of a workspace package. */
function getWorkspaceDependencyEntry(
  lock: Lockfile,
  workspaceName: string | undefined,
  dependency: string,
): BunPackageEntry | undefined {
  const key = resolveWorkspaceDependencyKey(lock.packages, workspaceName, dependency)
  return key === undefined ? undefined : lock.packages[key]
}

/**
 * Returns whether two lockfile entries resolve to the same package.
 *
 * Compares the resolution, registry, and integrity, but not the metadata object,
 * because Bun versions differ in the metadata they record.
 */
function isSameResolution(expected: BunPackageEntry, actual: BunPackageEntry | undefined) {
  const strings = (entry: BunPackageEntry) => entry.filter(value => typeof value === "string")
  return (
    actual !== undefined && JSON.stringify(strings(expected)) === JSON.stringify(strings(actual))
  )
}

function toCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, nested: unknown) =>
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested,
  )
}
