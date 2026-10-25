import path from "node:path"

import {
  findReplacedOverrideRules,
  overrideParentRangeIncludes,
  readManifestOverrides,
} from "bunlock-lockfile"

import { isNestedPath } from "./paths"

/** Root `package.json` fields that can be synced from the nested repository. */
export type SyncedField =
  | "catalog"
  | "catalogs"
  | "overrides"
  | "patchedDependencies"
  | "trustedDependencies"

/** All root fields in sync order; the default for `NestedWorkspaceConfig.fields`. */
export const syncedFields: readonly SyncedField[] = [
  "catalog",
  "catalogs",
  "overrides",
  "patchedDependencies",
  "trustedDependencies",
]

/** Field of the host `package.json` that holds `NestedWorkspaceConfig`. */
export const configField = "bun-nested-workspace"

/**
 * Names of host entries that came from the nested repository during the last sync.
 *
 * The sync maintains these lists to tell synced entries from the host's own ones,
 * so it can remove entries that the nested repository dropped.
 * Patches need no list: a synced patch is the one whose path lies inside the nested directory.
 */
export interface SyncedEntries {
  catalog?: string[]
  catalogs?: Record<string, string[]>
  overrides?: string[]
  trustedDependencies?: string[]
}

/** Configuration stored in the `bun-nested-workspace` field of the host `package.json`. */
export interface NestedWorkspaceConfig {
  /** Directory of the nested repository checkout, relative to the host root. */
  dir: string
  /** Root fields to sync; all of `syncedFields` when omitted. */
  fields?: SyncedField[]
  /** Maintained by the sync; do not edit by hand. */
  synced?: SyncedEntries
}

/** Validated `NestedWorkspaceConfig` with defaults applied. */
export interface ResolvedConfig {
  /** Normalized relative POSIX path without a trailing slash. */
  dir: string
  fields: readonly SyncedField[]
  synced: SyncedEntries
}

type Catalog = Record<string, string>

/** Value of an `overrides` entry: a version spec, or a group of rules keyed by `"."` and dependency selectors. */
type OverrideValue = string | Record<string, string>

/** Root `package.json` fields this package reads or rewrites; other fields are preserved as is. */
export interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: string[] | WorkspacesConfig
  catalog?: Catalog
  catalogs?: Record<string, Catalog>
  overrides?: Record<string, OverrideValue>
  resolutions?: Record<string, string>
  patchedDependencies?: Record<string, string>
  trustedDependencies?: string[]
  [configField]?: NestedWorkspaceConfig
  [key: string]: unknown
}

/** Object form of the `workspaces` field of a root `package.json`. */
export interface WorkspacesConfig {
  packages?: string[]
  catalog?: Catalog
  catalogs?: Record<string, Catalog>
  [key: string]: unknown
}

/** Reads and validates the `bun-nested-workspace` config of the host `package.json`. */
export function readConfig(manifest: PackageManifest): ResolvedConfig {
  const config = manifest[configField]
  if (typeof config !== "object" || config === null) {
    throw new Error(`package.json has no "${configField}" field with the nested directory`)
  }
  if (typeof config.dir !== "string" || !config.dir) {
    throw new Error(`"${configField}.dir" must be a non-empty string`)
  }

  const normalized = path.posix.normalize(config.dir)
  const dir = normalized.replace(/\/+$/, "")
  if (
    path.posix.isAbsolute(normalized) ||
    !dir ||
    dir === "." ||
    dir === ".." ||
    dir.startsWith("../")
  ) {
    throw new Error(
      `"${configField}.dir" must be a directory inside the host root, got "${config.dir}"`,
    )
  }

  const fields = config.fields ?? syncedFields
  if (!Array.isArray(fields) || fields.some(field => !syncedFields.includes(field))) {
    throw new Error(
      `"${configField}.fields" must be an array of ${syncedFields.join(", ")}, got ${JSON.stringify(fields)}`,
    )
  }

  return { dir, fields, synced: config.synced ?? {} }
}

/**
 * Returns the catalogs of a root `package.json`.
 *
 * Bun reads catalogs either from `workspaces` or from the top level, so a field defined in both places is rejected.
 */
export function getCatalogs(manifest: PackageManifest): {
  catalog?: Catalog
  catalogs?: Record<string, Catalog>
} {
  const workspaces = Array.isArray(manifest.workspaces) ? undefined : manifest.workspaces
  for (const field of ["catalog", "catalogs"] as const) {
    if (manifest[field] && workspaces?.[field]) {
      throw new Error(`package.json defines both "${field}" and "workspaces.${field}"`)
    }
  }

  return {
    catalog: manifest.catalog ?? workspaces?.catalog,
    catalogs: manifest.catalogs ?? workspaces?.catalogs,
  }
}

/**
 * Returns a copy of the manifest with the catalog fields replaced.
 *
 * Each catalog field stays where the manifest keeps it.
 * A new field goes to the top level when the manifest keeps the other catalog field there, and to `workspaces` otherwise.
 */
function setCatalogs(
  manifest: PackageManifest,
  catalogs: { catalog?: Catalog; catalogs?: Record<string, Catalog> },
): PackageManifest {
  const result = { ...manifest }
  const workspaces: WorkspacesConfig = Array.isArray(manifest.workspaces)
    ? { packages: manifest.workspaces }
    : { ...manifest.workspaces }

  for (const [field, other] of [
    ["catalog", "catalogs"],
    ["catalogs", "catalog"],
  ] as const) {
    const topLevel = field in manifest || (!(field in workspaces) && other in manifest)
    const target: Record<string, unknown> = topLevel ? result : workspaces
    if (catalogs[field] !== undefined && Object.keys(catalogs[field]).length) {
      target[field] = catalogs[field]
    } else {
      delete target[field]
    }
  }

  if (manifest.workspaces !== undefined || Object.keys(workspaces).length) {
    // An array stays an array unless a catalog needs the object form.
    const keepArray = Array.isArray(manifest.workspaces) && Object.keys(workspaces).length === 1
    result.workspaces = keepArray ? workspaces.packages : workspaces
  }
  return result
}

/** Returns the distinct ranges that the root `package.json` declares for a package across its dependency groups. */
function getDeclaredRanges(manifest: PackageManifest, name: string): string[] {
  const groups = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]
  return [
    ...new Set(
      groups.flatMap(group => (group && Object.hasOwn(group, name) ? [group[name]!] : [])),
    ),
  ]
}

/**
 * Returns the range that a `$name` override value refers to, or the value itself when it is not a reference.
 *
 * Bun replaces `$name` with the range that the root `package.json` declares for `name`, as written.
 * Resolves only references to the root's own declarations: throws when the reference names another package,
 * which Bun versions resolve differently, and when the dependency groups declare no range or different ranges for it.
 */
export function resolveOverrideValue(
  manifest: PackageManifest,
  name: string,
  value: string,
  source = "package.json",
): string {
  if (!value.startsWith("$")) {
    return value
  }
  const entry = `${source} override ${JSON.stringify(name)}: ${JSON.stringify(value)}`
  if (value.slice(1) !== name) {
    throw new Error(
      `${entry} refers to another package, which Bun versions resolve differently; replace it with an explicit range`,
    )
  }
  const ranges = getDeclaredRanges(manifest, name)
  if (ranges.length !== 1) {
    throw new Error(
      `${entry} refers to ${ranges.length ? "different ranges in the dependency groups" : "a dependency that the root does not declare"}; replace it with an explicit range`,
    )
  }
  return ranges[0]!
}

/** Host entry that a nested entry with the same name replaced during the sync. */
export interface OverriddenEntry {
  /** Field path, such as `catalog`, `catalogs.testing`, or `overrides`. */
  field: string
  name: string
  hostValue: OverrideValue
  nestedValue: OverrideValue
}

/** Result of `syncManifest`. */
export interface ManifestSync {
  manifest: PackageManifest
  overridden: OverriddenEntry[]
  /**
   * Whether the sync added `trustedDependencies` to a host that did not define it.
   *
   * The explicit list replaces the default trusted list of Bun,
   * so host dependencies that relied on the default list no longer run their lifecycle scripts.
   */
  addedTrustedDependencies: boolean
}

/**
 * Returns the host root `package.json` with the configured root fields of the nested `package.json` merged in.
 *
 * A nested entry replaces a host entry with the same key, while the other host entries stay.
 * Entries synced earlier and dropped by the nested repository are removed.
 * Throws when the host and the nested repository patch the same package version,
 * when either side defines `resolutions` while `overrides` are synced,
 * when an override is one that `readManifestOverrides` rejects, when two overrides select the same packages,
 * when a synced `$name` override would refer to another range in the host root than in the nested root,
 * and when a synced override selects the nested root by a range that its version satisfies.
 */
export function syncManifest(host: PackageManifest, nested: PackageManifest): ManifestSync {
  const config = readConfig(host)
  const overridden: OverriddenEntry[] = []
  const synced: SyncedEntries = { ...config.synced }
  let manifest: PackageManifest = { ...host }

  const hostCatalogs = getCatalogs(host)
  const nestedCatalogs = getCatalogs(nested)
  const catalogs = { ...hostCatalogs }

  if (config.fields.includes("catalog")) {
    const merged = mergeEntries(
      "catalog",
      hostCatalogs.catalog,
      nestedCatalogs.catalog,
      synced.catalog,
    )
    catalogs.catalog = merged.entries
    synced.catalog = merged.synced
    overridden.push(...merged.overridden)
  }

  if (config.fields.includes("catalogs")) {
    const names = new Set([
      ...Object.keys(hostCatalogs.catalogs ?? {}),
      ...Object.keys(nestedCatalogs.catalogs ?? {}),
      ...Object.keys(synced.catalogs ?? {}),
    ])
    const entries: Record<string, Catalog> = {}
    const syncedCatalogs: Record<string, string[]> = {}
    for (const name of [...names].sort()) {
      const merged = mergeEntries(
        `catalogs.${name}`,
        hostCatalogs.catalogs?.[name],
        nestedCatalogs.catalogs?.[name],
        synced.catalogs?.[name],
      )
      entries[name] = merged.entries
      syncedCatalogs[name] = merged.synced
      overridden.push(...merged.overridden)
    }
    catalogs.catalogs = omitEmpty(entries)
    synced.catalogs = omitEmpty(syncedCatalogs)
  }

  manifest = setCatalogs(manifest, catalogs)

  if (config.fields.includes("overrides")) {
    // Bun ignores `resolutions` whenever `overrides` is present, including an empty object,
    // so synced overrides would disable the host resolutions, and nested resolutions would be lost.
    for (const [source, resolutions] of [
      ["The host package.json", host.resolutions],
      [`${config.dir}/package.json`, nested.resolutions],
    ] as const) {
      if (resolutions && Object.keys(resolutions).length) {
        throw new Error(
          `${source} defines "resolutions", which Bun ignores once "overrides" is defined; move its entries to "overrides"`,
        )
      }
    }
    const nestedSource = `${config.dir}/package.json`
    // The nested root dependencies stay out of the host root, so a nested `$name` override keeps its meaning
    // only when the host root declares the same range.
    const nestedRules = readManifestOverrides(
      nested.overrides ?? {},
      (name, value) => {
        const nestedRange = resolveOverrideValue(nested, name, value, nestedSource)
        const hostRanges = getDeclaredRanges(host, name)
        if (value.startsWith("$") && (hostRanges.length !== 1 || hostRanges[0] !== nestedRange)) {
          throw new Error(
            `${nestedSource} override ${JSON.stringify(name)}: ${JSON.stringify(value)} refers to ${JSON.stringify(nestedRange)} in the nested root, but the host root ${hostRanges.length ? `declares ${hostRanges.map(range => JSON.stringify(range)).join(", ")}` : "does not declare it"}; replace it with an explicit range`,
          )
        }
        return nestedRange
      },
      nestedSource,
    )
    // Bun gives the root package no version, so a parent range never selects the nested root in its own repository.
    // In the host the nested root is a workspace with the version of its package.json.
    for (const { key, parent } of nestedRules) {
      if (
        parent?.range &&
        parent.name === nested.name &&
        typeof nested.version === "string" &&
        // Matched as the merge matches it; a range the tools cannot evaluate counts as matching.
        overrideParentRangeIncludes(parent.range, nested.version) !== false
      ) {
        throw new Error(
          `${nestedSource} override ${key} selects the nested root ${parent.name}@${nested.version} by a version range, which applies in the host but not in the nested repository; remove the range`,
        )
      }
    }
    const merged = mergeEntries("overrides", host.overrides, nested.overrides, synced.overrides)
    // Bun applies the later of two rules that select the same packages, and the merge sorts the keys.
    const [replaced] = findReplacedOverrideRules(
      readManifestOverrides(merged.entries, (_, value) => value),
    )
    if (replaced) {
      throw new Error(
        `The overrides ${replaced[0].key} and ${replaced[1].key} select the same packages, so Bun applies one of them depending on the order of the keys; keep one of them`,
      )
    }
    manifest.overrides = merged.entries
    synced.overrides = merged.synced
    overridden.push(...merged.overridden)
  }

  if (config.fields.includes("patchedDependencies")) {
    manifest.patchedDependencies = mergePatches(
      host.patchedDependencies,
      nested.patchedDependencies,
      config.dir,
    )
  }

  if (config.fields.includes("trustedDependencies")) {
    const toEntries = (names: string[] = []) => Object.fromEntries(names.map(name => [name, name]))
    const merged = mergeEntries(
      "trustedDependencies",
      toEntries(host.trustedDependencies),
      toEntries(nested.trustedDependencies),
      synced.trustedDependencies,
    )
    // An explicit list replaces Bun's default trusted list and an empty one disables it,
    // so the field stays, even empty, when either side defines it.
    if (host.trustedDependencies !== undefined || nested.trustedDependencies !== undefined) {
      manifest.trustedDependencies = Object.keys(merged.entries)
    }
    synced.trustedDependencies = merged.synced
  }

  for (const field of ["overrides", "patchedDependencies"] as const) {
    const value = manifest[field]
    if (config.fields.includes(field) && value !== undefined && !Object.keys(value).length) {
      delete manifest[field]
    }
  }

  const { synced: _, ...rest } = host[configField]!
  const syncedEntries = omitEmpty(synced as Record<string, unknown>)
  manifest[configField] = Object.keys(syncedEntries).length
    ? { ...rest, synced: syncedEntries }
    : rest

  return {
    manifest,
    overridden,
    addedTrustedDependencies:
      host.trustedDependencies === undefined && manifest.trustedDependencies !== undefined,
  }
}

/**
 * Merges the entries of one field by their keys.
 *
 * Host entries outside `synced` are the host's own.
 * An own entry equal to the nested one stays own, so it survives if the nested repository drops it later.
 */
function mergeEntries<T extends OverrideValue>(
  field: string,
  host: Record<string, T> = {},
  nested: Record<string, T> = {},
  synced: string[] = [],
) {
  const own = Object.fromEntries(Object.entries(host).filter(([name]) => !synced.includes(name)))
  const isOwn = (name: string) => name in own && isSameValue(own[name]!, nested[name]!)
  const overridden = Object.entries(nested)
    .filter(([name]) => name in own && !isOwn(name))
    .map(([name, nestedValue]) => ({ field, name, hostValue: own[name]!, nestedValue }))

  return {
    entries: sortKeys({ ...own, ...nested }),
    synced: Object.keys(nested)
      .filter(name => !isOwn(name))
      .sort(),
    overridden,
  }
}

/** Returns whether two entry values are equal, ignoring the key order of groups. */
function isSameValue(left: OverrideValue, right: OverrideValue) {
  const toText = (value: OverrideValue) =>
    typeof value === "string" ? value : JSON.stringify(sortKeys(value))
  return typeof left === typeof right && toText(left) === toText(right)
}

/** Merges host patches with the nested patches, rewriting nested patch paths through the nested directory. */
function mergePatches(
  host: Record<string, string> = {},
  nested: Record<string, string> = {},
  dir: string,
) {
  const own = Object.entries(host).filter(
    ([, patch]) => !isNestedPath(path.posix.normalize(patch), dir),
  )
  const relocated = Object.entries(nested).map(([key, patch]): [string, string] => [
    key,
    path.posix.join(dir, patch),
  ])
  const conflicts = own.filter(([key]) => key in nested).map(([key]) => key)
  if (conflicts.length) {
    throw new Error(
      `Both the host and ${dir} patch ${conflicts.join(", ")}; keep a single patch for each package version`,
    )
  }

  return sortKeys(Object.fromEntries([...own, ...relocated]))
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Drops empty arrays and objects from a record. */
function omitEmpty<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== undefined && Object.keys(value as object).length,
    ),
  )
}

/** Difference between the expected and the actual value at a `package.json` path. */
export interface ManifestDifference {
  /** Dot-separated path, such as `catalog.h3`. */
  path: string
  expected?: unknown
  actual?: unknown
}

/**
 * Returns the differences of the synced root fields and the synced entry lists between two manifests.
 *
 * Key order and the order of `trustedDependencies` are ignored.
 */
export function diffManifests(
  expected: PackageManifest,
  actual: PackageManifest,
): ManifestDifference[] {
  const { fields } = readConfig(expected)
  const pick = (manifest: PackageManifest) => {
    const catalogs = getCatalogs(manifest)
    const values: Record<string, unknown> = {
      catalog: catalogs.catalog,
      catalogs: catalogs.catalogs,
      overrides: manifest.overrides,
      patchedDependencies: manifest.patchedDependencies,
      trustedDependencies: manifest.trustedDependencies && [...manifest.trustedDependencies].sort(),
    }
    return {
      ...Object.fromEntries(fields.map(field => [field, values[field]])),
      [`${configField}.synced`]: manifest[configField]?.synced,
    }
  }

  return diffValues("", pick(expected), pick(actual))
}

function diffValues(prefix: string, expected: unknown, actual: unknown): ManifestDifference[] {
  if (isRecord(expected) && isRecord(actual)) {
    return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
      .sort()
      .flatMap(key => diffValues(prefix ? `${prefix}.${key}` : key, expected[key], actual[key]))
  }
  if (isRecord(expected) && actual === undefined) {
    return diffValues(prefix, expected, {})
  }
  if (expected === undefined && isRecord(actual)) {
    return diffValues(prefix, {}, actual)
  }
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? []
    : [{ path: prefix, expected, actual }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
