import semver from "semver"

import { effectiveDependencyRange } from "./overrides"
import { type BunLockFile, type BunPackageMeta, isOptionalPeerDependency } from "./parse"

/** Return undefined when a range or version has no supported semver interpretation. */
export function evaluateRangeCompatibility(
  range: string,
  targetVersion: string,
): boolean | undefined {
  if (!semver.valid(targetVersion)) {
    return undefined
  }

  const normalized = range.trim()
  if (!normalized) {
    return undefined
  }

  if (
    normalized.startsWith("workspace:") ||
    normalized.startsWith("catalog:") ||
    normalized.startsWith("link:") ||
    normalized.startsWith("file:")
  ) {
    return undefined
  }

  if (semver.valid(normalized)) {
    return semver.eq(targetVersion, normalized)
  }

  const validRange = semver.validRange(normalized)
  if (!validRange) {
    return undefined
  }

  return semver.satisfies(targetVersion, validRange)
}

/**
 * Decide whether a resolved dependency should form a reachability edge.
 *
 * Only a known-incompatible optional peer is absent; required dependencies and
 * peers with unknown compatibility stay reachable.
 */
export function isResolvedDependencyReachable(
  lock: Pick<BunLockFile, "overrides">,
  requester: Pick<
    BunPackageMeta,
    "dependencies" | "optionalDependencies" | "peerDependencies" | "optionalPeers"
  >,
  dependencyName: string,
  resolvedVersion: string,
): boolean {
  if (!isOptionalPeerDependency(requester, dependencyName)) return true

  const range = requester.peerDependencies?.[dependencyName]
  if (!range) return true

  return (
    evaluateRangeCompatibility(
      effectiveDependencyRange(lock, dependencyName, range),
      resolvedVersion,
    ) !== false
  )
}
