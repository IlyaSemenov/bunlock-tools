import JSON5 from "json5"

import { type BunRange, isNpmRangeSpecifier, parseBunRange, trimSpecifier } from "./selector-ranges"

export type DependencyMap = Record<string, string>

export type BunLockWorkspace = {
  /**
   * Optional in Bun lockfiles. When present, it is also used as the lookup
   * context for workspace-scoped lock keys.
   */
  name?: string
  /** Version of a workspace package; Bun leaves it out for the root workspace. */
  version?: string
  dependencies?: DependencyMap
  devDependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
}

/**
 * Metadata stored in a Bun package tuple.
 *
 * `bundled` is context-specific in Bun lockfiles: it belongs to entries under
 * the package that bundles them and must not be blindly copied to another
 * lock key when reusing a package tuple as a dedupe template.
 */
export type BunPackageMeta = {
  dependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
  /** Peer dependency names Bun treats as optional. */
  optionalPeers?: string[]
  /** True only inside the package subtree that actually bundles this entry. */
  bundled?: boolean
  bin?: string | Record<string, string>
  os?: string | string[]
  cpu?: string | string[]
}

/**
 * Bun lockfile package tuple.
 *
 * Registry packages use `[spec, resolved, metadata, integrity]`, while git
 * packages use `[spec, metadata, resolved, integrity]`. Bun omits trailing
 * values freely in either form.
 */
export type BunRegistryPackageEntry = [
  /** Resolved package spec in `name@version` form. */
  spec: string,
  /** Optional resolved source; registry packages commonly use an empty string. */
  resolved?: string,
  meta?: BunPackageMeta,
  integrity?: string,
]

export type BunGitPackageEntry = [
  /** Resolved git package spec in `name@source` form. */
  spec: string,
  meta: BunPackageMeta,
  /** Optional resolved git cache identifier. */
  resolved?: string,
  integrity?: string,
]

export type BunPackageEntry = BunRegistryPackageEntry | BunGitPackageEntry

/** Parsed `bun.lock` sections that the tools read; Bun may preserve additional top-level keys. */
export type BunLockFile = {
  lockfileVersion?: number
  configVersion?: number
  workspaces?: Record<string, BunLockWorkspace>
  /** Default catalog of the root `package.json`. */
  catalog?: DependencyMap
  /** Named catalogs of the root `package.json`. */
  catalogs?: Record<string, DependencyMap>
  /**
   * Canonical map Bun writes for package.json overrides and resolutions.
   *
   * A string value overrides a package by name; an object value groups the rules scoped to a package or its range.
   */
  overrides?: Record<string, string | DependencyMap>
  /** Package specs whose local patches may change their dependency declarations. */
  patchedDependencies?: Record<string, string>
  packages?: Record<string, BunPackageEntry>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isPackageEntry(value: unknown): value is BunPackageEntry {
  return Array.isArray(value) && typeof value[0] === "string"
}

export function isGitPackageEntry(entry: BunPackageEntry): entry is BunGitPackageEntry {
  return isObject(entry[1])
}

/**
 * Return whether a package entry needs `lockfileVersion` 1, because Bun 1.4.4 rejects it in a lockfile of a later version.
 *
 * Version 2 adds checks on reading: an npm integrity is a hash that Bun supports or empty,
 * an npm package from a tarball outside the default registry has a supported integrity,
 * and the checkout tag of a git package is a single safe path component.
 * Bun writes version 1 when an entry fails them, and discards a lockfile of a later version that has such an entry.
 * An entry that Bun rejects at every version, such as a GitHub package with an unsafe tag, does not need version 1.
 */
export function needsLockfileVersion1(entry: BunPackageEntry): boolean {
  if (isGitPackageEntry(entry)) {
    const tag = entry[2]
    // Bun checks the tag of a GitHub package at every version, so only other git sources depend on the version.
    const isGit = parseResolvedSpec(entry[0])?.version.startsWith("git+") ?? false
    return isGit && tag !== undefined && !isSafeGitTag(tag)
  }
  const [, url = "", , integrity = ""] = entry
  if (isSupportedIntegrity(integrity)) return false
  // Bun writes an empty URL for a tarball from the default registry, and when choosing the version to write it accepts
  // only URLs under that registry, whatever the configuration.
  return Boolean(integrity) || (Boolean(url) && !isUnderDefaultRegistry(url))
}

const defaultRegistry = "https://registry.npmjs.org"

function isUnderDefaultRegistry(url: string): boolean {
  return (
    url.startsWith(defaultRegistry) &&
    (url.length === defaultRegistry.length || url[defaultRegistry.length] === "/")
  )
}

const digestLengths: Record<string, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }

/** Return whether an integrity has a hash that Bun supports, as Bun's `Integrity::parse` reads it. */
function isSupportedIntegrity(integrity: string): boolean {
  return integrity.split(/\s/).some(hash => {
    const separator = hash.slice(0, 7).indexOf("-")
    if (hash.length < "sha256-".length || separator === -1 || hash.length <= separator + 1)
      return false
    const digestLength = digestLengths[hash.slice(0, separator)]
    const encoded = hash
      .slice(separator + 1)
      .split("?")[0]!
      .replace(/=+$/, "")
    return (
      digestLength !== undefined &&
      /^[A-Za-z0-9+/]*$/.test(encoded) &&
      encoded.length % 4 !== 1 &&
      Math.floor((encoded.length * 3) / 4) <= digestLength
    )
  })
}

/** Return whether a git checkout tag is a single safe path component, as Bun's `is_safe_resolved_tag` checks it. */
function isSafeGitTag(tag: string): boolean {
  return (
    tag.length <= 256 && tag !== "." && tag !== ".." && /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(tag)
  )
}

export function packageEntryMeta(entry: BunPackageEntry): BunPackageMeta | undefined {
  if (isGitPackageEntry(entry)) return entry[1]

  const maybeMeta = entry[2]
  return isObject(maybeMeta) ? maybeMeta : undefined
}

export function normalizeDependencyMap(value: unknown): DependencyMap {
  if (!isObject(value)) {
    return {}
  }

  const normalized: DependencyMap = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      normalized[key] = item
    }
  }

  return normalized
}

/** True when a peer is optional and is not also installed as a dependency. */
export function isOptionalPeerDependency(
  metadata: Pick<BunPackageMeta, "dependencies" | "optionalDependencies" | "optionalPeers">,
  dependencyName: string,
): boolean {
  if (!Array.isArray(metadata.optionalPeers) || !metadata.optionalPeers.includes(dependencyName)) {
    return false
  }

  return (
    !Object.hasOwn(normalizeDependencyMap(metadata.dependencies), dependencyName) &&
    !Object.hasOwn(normalizeDependencyMap(metadata.optionalDependencies), dependencyName)
  )
}

/**
 * Splits Bun's resolved package spec (`name@version`) at the first `@` after
 * the leading `@` of a scoped name, as Bun does.
 *
 * The version part may contain `@` itself, as in a git, tarball, or workspace
 * source such as `pkg@git+ssh://git@host/repo.git#sha`.
 */
export function parseResolvedSpec(spec: string): { name: string; version: string } | null {
  const atIndex = spec.indexOf("@", 1)
  if (atIndex <= 0 || atIndex >= spec.length - 1) {
    return null
  }

  const name = spec.slice(0, atIndex)
  const version = spec.slice(atIndex + 1)
  if (!name || !version) {
    return null
  }

  return { name, version }
}

/** Error thrown when `bun.lock` has a structure that the tools do not support, or an override they cannot evaluate. */
export class BunLockFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BunLockFormatError"
  }
}

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
 * A range in an override key, or a declared range that one is compared with, as Bun reads them.
 *
 * `unparsed` is a specifier that Bun may read as an npm range, but the tools cannot parse, such as `01.2.3`.
 */
export type SelectorRange =
  | { kind: "semver"; range: BunRange; alias?: string }
  | { kind: "catalog"; catalog: string }
  | { kind: "unparsed"; alias?: string }

/** Override rule that is scoped to a parent package, to a range of the target, or both. */
export type ScopedOverride = {
  /** The rule as written in `bun.lock`, for messages. */
  key: string
  parent?: { name: string; range?: BunRange; rangeText: string }
  /** Target range as written in the key, for tie-breaks; empty without a range. */
  targetRangeText: string
  targetRange?: SelectorRange
  value: string
}

/** Rules of the `bun.lock` `overrides` section. */
export type OverrideRules = {
  /** Overrides by package name. */
  flat: Map<string, string>
  /** Scoped rules by target package name. */
  scopedByName: Map<string, ScopedOverride[]>
}

const overrideRulesCache = new WeakMap<object, OverrideRules>()

/**
 * Return the rules of the `bun.lock` `overrides` section, read once per section object.
 *
 * Throws `BunLockFormatError` when the section has a shape or a key that Bun does not read or the tools cannot evaluate.
 */
export function getOverrideRules(overrides: unknown): OverrideRules | undefined {
  if (overrides === undefined) return undefined
  if (!isObject(overrides) || Array.isArray(overrides)) {
    throw new BunLockFormatError("bun.lock overrides must be an object")
  }
  let rules = overrideRulesCache.get(overrides)
  if (!rules) {
    rules = readOverrideRules(overrides)
    overrideRulesCache.set(overrides, rules)
  }
  return rules
}

/**
 * Read the rules of the `bun.lock` `overrides` section, as Bun 1.4.4 does.
 *
 * A string value is an override by name.
 * An object value is a group under the key `name` or `name@range`: its `"."` child overrides that package itself,
 * and any other child `dep` or `dep@range` overrides a dependency of it.
 */
function readOverrideRules(overrides: Record<string, unknown>): OverrideRules {
  const rules: OverrideRules = { flat: new Map(), scopedByName: new Map() }
  const addScoped = (name: string, rule: ScopedOverride) => {
    const scoped = rules.scopedByName.get(name) ?? []
    // Like Bun, a later rule replaces one with the same parent and ranges.
    const index = scoped.findIndex(
      existing =>
        existing.parent?.name === rule.parent?.name &&
        existing.parent?.rangeText === rule.parent?.rangeText &&
        existing.targetRangeText === rule.targetRangeText,
    )
    if (index === -1) scoped.push(rule)
    else scoped[index] = rule
    rules.scopedByName.set(name, scoped)
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      rules.flat.set(key, value)
      continue
    }
    if (!isObject(value) || Array.isArray(value)) {
      throw new BunLockFormatError(
        `bun.lock override ${JSON.stringify(key)} must be a string or an object of strings`,
      )
    }

    const group = parseOverrideKey(key)
    for (const [childKey, childValue] of Object.entries(value)) {
      if (typeof childValue !== "string") {
        throw new BunLockFormatError(
          `bun.lock override ${JSON.stringify(key)} must be a string or an object of strings`,
        )
      }
      if (childKey === "." && !group.range) {
        rules.flat.set(group.name, childValue)
        continue
      }

      const target = childKey === "." ? group : parseOverrideKey(childKey)
      const parent = childKey === "." ? undefined : group
      if (parent && !isParentSegment(parent)) throw unsupportedKey(key)
      addScoped(target.name, {
        key:
          childKey === "."
            ? JSON.stringify(key)
            : `${JSON.stringify(key)} > ${JSON.stringify(childKey)}`,
        parent: parent && {
          name: parent.name,
          range: parent.selector?.kind === "semver" ? parent.selector.range : undefined,
          rangeText: parent.range,
        },
        targetRangeText: target.range,
        targetRange: target.selector,
        value: childValue,
      })
    }
  }
  return rules
}

/** Package name with an optional range, as an override key selects a package. */
export type OverrideSegment = {
  name: string
  /** Range as Bun records it, without an `npm:` prefix before a range; empty without a range. */
  range: string
  selector?: SelectorRange
}

/**
 * Split an override key segment into a package name and a range, as Bun's `parse_package_segment` does.
 *
 * `npm:` before a range is dropped, while `npm:other` and `npm:other@range` stay aliases.
 * Returns `undefined` for a segment that Bun rejects and for a range other than a semver range or a catalog,
 * which the tools cannot evaluate.
 */
export function parseOverrideSegment(segment: string): OverrideSegment | undefined {
  const separator = segment.indexOf("@", 1)
  const name = separator === -1 ? segment : segment.slice(0, separator)
  let range = separator === -1 ? "" : segment.slice(separator + 1)
  if (range.startsWith("npm:")) {
    const rest = range.slice("npm:".length)
    if (!rest || isNpmRangeSpecifier(rest) === true) range = rest
  }
  if (!name || (name.startsWith("@") && !name.includes("/")) || (separator !== -1 && !range)) {
    return undefined
  }
  if (!range) return { name, range }

  const selector = toSelectorRange(range)
  if (!selector || selector.kind === "unparsed") return undefined
  return { name, range, selector }
}

/** Return whether a parent segment has no range or a range that Bun matches against the installed version. */
export function isParentSegment({ selector }: OverrideSegment): boolean {
  // A parent is selected by its installed version, so Bun reads only a semver range there.
  return !selector || (selector.kind === "semver" && selector.alias === undefined)
}

function parseOverrideKey(key: string): OverrideSegment {
  const segment = parseOverrideSegment(key)
  if (!segment) throw unsupportedKey(key)
  return segment
}

function unsupportedKey(key: string): BunLockFormatError {
  return new BunLockFormatError(
    `bun.lock override key ${JSON.stringify(key)} is not a package name with an optional semver range`,
  )
}

/**
 * Read a range in an override key, or a declared range, as Bun compares them.
 *
 * Returns `undefined` for a specifier that no selector range matches, such as a dist-tag or a git URL.
 */
export function toSelectorRange(specifier: string): SelectorRange | undefined {
  const text = trimSpecifier(specifier)
  if (text.startsWith("catalog:")) {
    return { kind: "catalog", catalog: text.slice("catalog:".length) }
  }
  const alias = npmAliasTarget(text)
  const range = alias ? alias.range : text.startsWith("npm:") ? text.slice("npm:".length) : text
  const isNpmRange = isNpmRangeSpecifier(range)
  if (isNpmRange === false) return undefined

  const parsed = isNpmRange && parseBunRange(range)
  return parsed
    ? { kind: "semver", range: parsed, alias: alias?.name }
    : { kind: "unparsed", alias: alias?.name }
}

/** Parses `bun.lock` text and throws `BunLockFormatError` on unsupported structure. */
export function parseBunLock(lockText: string): BunLockFile {
  const parsed = JSON5.parse(lockText)
  if (!isObject(parsed)) {
    throw new BunLockFormatError("bun.lock must parse to an object")
  }

  getOverrideRules(parsed.overrides)

  return parsed as BunLockFile
}
