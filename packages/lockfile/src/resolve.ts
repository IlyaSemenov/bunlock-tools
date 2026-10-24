/** Lock keys to resolve against: a map keyed by lock key, or the `packages` section of `bun.lock`. */
export type LockKeys = ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>

/**
 * Tell whether a lock key is a nested entry of a dependency: the last of several package names in the key.
 *
 * A suffix match is not enough: `@scope/name` is a root package key, and `app/@alias/name` is a nested entry
 * of the dependency `@alias/name`, such as an `npm:` alias.
 */
export function isNestedDependencyLockKey(lockKey: string, dependencyName: string): boolean {
  const names = splitLockKey(lockKey)
  return names.length > 1 && names.at(-1) === dependencyName
}

/**
 * Resolve a dependency the way Bun lock keys are structured:
 * nearest nested `requester/dependency` wins, then the closest
 * ancestor-provided nested entry, then root `dependency`.
 *
 * This is the canonical lock-key resolution shared by graph building, update
 * planning, and update safety checks; only the lock keys matter.
 *
 * @param requesterLockKey Package lock key or workspace name that owns the
 * dependency. Use `undefined` for context-free resolution, which accepts a
 * nested entry only when it is the unique candidate.
 * @param dependencyName Real npm package name being resolved.
 */
export function resolveDependencyLockKey(
  requesterLockKey: string | undefined,
  dependencyName: string,
  packagesByLockKey: LockKeys,
): string | undefined {
  if (requesterLockKey) {
    // Each lock key segment is a package name, so walking up the names visits the requester and then its ancestors.
    const names = splitLockKey(requesterLockKey)
    for (let depth = names.length; depth > 0; depth--) {
      const nestedKey = `${names.slice(0, depth).join("/")}/${dependencyName}`
      if (hasLockKey(packagesByLockKey, nestedKey)) {
        return nestedKey
      }
    }
  }

  if (hasLockKey(packagesByLockKey, dependencyName)) {
    return dependencyName
  }

  if (!requesterLockKey) {
    let uniqueCandidate: string | undefined
    for (const key of getLockKeys(packagesByLockKey)) {
      if (!isNestedDependencyLockKey(key, dependencyName)) {
        continue
      }

      if (uniqueCandidate) {
        return undefined
      }

      uniqueCandidate = key
    }

    return uniqueCandidate
  }

  return undefined
}

/** Split a lock key into the package names of its nesting chain, keeping scoped names whole. */
export function splitLockKey(lockKey: string): string[] {
  return lockKey.match(/(?:@[^/]+\/)?[^/]+/g) ?? []
}

function hasLockKey(packagesByLockKey: LockKeys, lockKey: string): boolean {
  return packagesByLockKey instanceof Map
    ? packagesByLockKey.has(lockKey)
    : Object.hasOwn(packagesByLockKey, lockKey)
}

function getLockKeys(packagesByLockKey: LockKeys): Iterable<string> {
  return packagesByLockKey instanceof Map
    ? packagesByLockKey.keys()
    : Object.keys(packagesByLockKey)
}
