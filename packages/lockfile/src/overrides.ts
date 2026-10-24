import semver from "semver"

import type { BunLockFile } from "./parse"

/**
 * Return the package and range that an `npm:` alias specifier installs, or `undefined` for any other specifier.
 *
 * Follows Bun: `npm:<name>@<version>` always names a package.
 * Without a version, a target with a range operator or an exact version, such as `npm:^1.0.0`, `npm:1.0.0`, or
 * `npm:v1.0.0`, is a range of the dependency itself; any other target, such as `npm:x`, `npm:1`, or `npm:1.x`, is a
 * package name.
 */
export function npmAliasTarget(specifier: string): { name: string; range: string } | undefined {
  if (!specifier.startsWith("npm:")) return undefined

  const target = specifier.slice("npm:".length)
  const separator = target.indexOf("@", 1)
  if (separator !== -1) {
    return { name: target.slice(0, separator), range: target.slice(separator + 1) }
  }
  const isRange = /[\^~><=*| ]/.test(target) || /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/i.test(target)
  return target && !isRange ? { name: target, range: "*" } : undefined
}

/**
 * Return the package and version range that a dependency specifier requires.
 *
 * An `npm:` alias requires the aliased package, and `npm:<range>` is a range of the dependency itself.
 */
export function dependencyRequirement(
  dependencyName: string,
  specifier: string,
): { name: string; range: string } {
  const alias = npmAliasTarget(specifier)
  if (alias) return alias
  return {
    name: dependencyName,
    range: specifier.startsWith("npm:") ? specifier.slice("npm:".length) : specifier,
  }
}

/**
 * Read the bare-name override that Bun applies to a dependency declaration.
 *
 * Bun never overrides an `npm:` alias of a semver range.
 * It overrides an alias of a dist-tag, such as `npm:debug@latest`, by the name of the aliased package,
 * so the override is returned as an alias of that package.
 * `parseBunLock` rejects overrides scoped to a parent package or a version selector.
 * Bun versions before 1.4 keep selector keys as strings without applying them,
 * so matching those here would diverge from the package manager.
 */
export function dependencyOverrideRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
  declaredRange: string,
): string | undefined {
  const alias = npmAliasTarget(declaredRange)
  if (!alias) return bareNameOverride(lock, dependencyName)
  if (!isDistTag(alias.range)) return undefined

  const override = bareNameOverride(lock, alias.name)
  if (override === undefined) return undefined
  // Bun reads the override under the aliased name, so a range keeps that package as the alias target,
  // while another alias or a source such as a git URL replaces the whole specifier.
  const requirement = dependencyRequirement(alias.name, override)
  return requirement.name !== alias.name || requirement.range.includes(":")
    ? override
    : `npm:${alias.name}@${requirement.range}`
}

function bareNameOverride(lock: Pick<BunLockFile, "overrides">, name: string): string | undefined {
  const overrides = lock.overrides
  if (!overrides || !Object.hasOwn(overrides, name)) return undefined
  return overrides[name]
}

/** Whether a version of an `npm:` alias is a dist-tag, such as `latest`, rather than a range or a source. */
function isDistTag(version: string): boolean {
  return /^[^\s:/#@]+$/.test(version) && semver.validRange(version) === null
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
  const overrideRange = dependencyOverrideRange(lock, dependencyName, declaredRange)
  return overrideRange === undefined ? declaredRange : overrideRange
}
