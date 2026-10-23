import type { BunPackageEntry } from "bunlock-lockfile"
import { resolveDependencyLockKey } from "bunlock-lockfile"

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

/** Returns the nested workspace paths that the host `workspaces` patterns do not include. */
export function findUncoveredWorkspaces(manifest: PackageManifest, nestedLock: Lockfile): string[] {
  const patterns = (
    Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? [])
  ).map(pattern => pattern.replace(/^(!?)\.\//, "$1").replace(/\/+$/, ""))
  const included = patterns
    .filter(pattern => !pattern.startsWith("!"))
    .map(pattern => new Bun.Glob(pattern))
  const excluded = patterns
    .filter(pattern => pattern.startsWith("!"))
    .map(pattern => new Bun.Glob(pattern.slice(1)))

  return Object.keys(nestedLock.workspaces).filter(
    workspacePath =>
      !included.some(glob => glob.match(workspacePath)) ||
      excluded.some(glob => glob.match(workspacePath)),
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

  return [...paths]
    .sort()
    .filter(
      workspacePath =>
        toCanonicalJson(lock.workspaces[workspacePath]) !==
        toCanonicalJson(nestedLock.workspaces[workspacePath]),
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
          satisfiesSpecifier(after, dependency, specifier, nestedEntry))
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
