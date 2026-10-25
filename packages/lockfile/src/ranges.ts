import semver from "semver"

import { dependencyRequirement, effectiveDependencyRange } from "./overrides"
import { type BunLockFile, type BunPackageMeta, isOptionalPeerDependency } from "./parse"
import type { OverrideRequester } from "./requester"

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
 *
 * @param requester Package that declares the dependency, for overrides scoped to it.
 */
export function isResolvedDependencyReachable(
  lock: Pick<BunLockFile, "overrides">,
  requester: OverrideRequester | undefined,
  metadata: Pick<
    BunPackageMeta,
    "dependencies" | "optionalDependencies" | "peerDependencies" | "optionalPeers"
  >,
  dependencyName: string,
  resolvedVersion: string,
): boolean {
  if (!isOptionalPeerDependency(metadata, dependencyName)) return true

  const range = metadata.peerDependencies?.[dependencyName]
  if (!range) return true

  const requirement = dependencyRequirement(
    dependencyName,
    effectiveDependencyRange(lock, requester, dependencyName, range),
  )
  return evaluateRangeCompatibility(requirement.range, resolvedVersion) !== false
}
