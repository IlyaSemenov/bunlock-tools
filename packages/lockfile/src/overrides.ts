import type { BunLockFile } from "./parse"

/**
 * Read the exact bare-name override Bun stores for a dependency.
 *
 * Bun 1.3.14 ignores selector keys and omits unsupported nested/path forms,
 * so matching those here would diverge from the package manager.
 */
export function dependencyOverrideRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
): string | undefined {
  const overrides = lock.overrides
  if (!overrides) return undefined
  if (!Object.hasOwn(overrides, dependencyName)) return undefined
  return overrides[dependencyName]
}

/**
 * Return the range Bun actually enforces for a dependency request.
 *
 * An override remains authoritative even when it is not valid semver;
 * compatibility then stays unknown instead of falling back to the declaration.
 */
export function effectiveDependencyRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
  declaredRange: string,
): string {
  const overrideRange = dependencyOverrideRange(lock, dependencyName)
  return overrideRange === undefined ? declaredRange : overrideRange
}
