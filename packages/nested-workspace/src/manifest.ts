import path from "node:path"

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

/** Root `package.json` fields this package reads or rewrites; other fields are preserved as is. */
export interface PackageManifest {
  workspaces?: string[] | WorkspacesConfig
  catalog?: Catalog
  catalogs?: Record<string, Catalog>
  overrides?: Record<string, string>
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

/** Host entry that a nested entry with the same name replaced during the sync. */
export interface OverriddenEntry {
  /** Field path, such as `catalog`, `catalogs.testing`, or `overrides`. */
  field: string
  name: string
  hostValue: string
  nestedValue: string
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
 * A nested entry replaces a host entry with the same name, while the other host entries stay.
 * Entries synced earlier and dropped by the nested repository are removed.
 * Throws when the host and the nested repository patch the same package version,
 * and when either side defines `resolutions` while `overrides` are synced.
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
    const merged = mergeEntries("overrides", host.overrides, nested.overrides, synced.overrides)
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
 * Merges name-keyed entries of one field.
 *
 * Host entries outside `synced` are the host's own.
 * An own entry equal to the nested one stays own, so it survives if the nested repository drops it later.
 */
function mergeEntries(
  field: string,
  host: Record<string, string> = {},
  nested: Record<string, string> = {},
  synced: string[] = [],
) {
  const own = Object.fromEntries(Object.entries(host).filter(([name]) => !synced.includes(name)))
  const overridden = Object.entries(nested)
    .filter(([name, value]) => name in own && own[name] !== value)
    .map(([name, nestedValue]) => ({ field, name, hostValue: own[name]!, nestedValue }))

  return {
    entries: sortKeys({ ...own, ...nested }),
    synced: Object.keys(nested)
      .filter(name => own[name] !== nested[name])
      .sort(),
    overridden,
  }
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
