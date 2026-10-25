import {
  type BunLockFile,
  type BunPackageEntry,
  dependencyOverrideRange,
  dependencyRequirement,
  evaluateRangeCompatibility,
  isOptionalPeerDependency,
  isPackageEntry,
  normalizeDependencyMap,
  type OverrideRequester,
  packageEntryMeta,
  packageOverrideRequester,
  parseResolvedSpec,
  resolveDependencyLockKey,
  splitLockKey,
  workspaceOverrideRequester,
} from "bunlock-lockfile"

import { type DependencyConflict, effectiveRequestRange } from "./analyze"
import type { RewriteProvenance } from "./rewrite"

type Packages = Record<string, BunPackageEntry>

/** One dependency declared by a package entry or a workspace, with its resolution. */
export type DependencyEdge = {
  /** Lock key of the requesting package; absent for a workspace. */
  requesterLockKey?: string
  /** Lock key context for resolution: the package lock key or the workspace name. */
  resolutionContext?: string
  /** Package spec of the requester, or the workspace path. */
  requesterSpec: string
  requesterPath: string[]
  dependencyName: string
  range: string
  overrideRange?: string
  /** True when the dependency may be absent, as an optional dependency. */
  optional: boolean
  resolvedLockKey?: string
  resolvedSpec?: string
}

/**
 * Collect every dependency edge of the package entries and workspaces, keyed by requester and dependency name.
 *
 * Optional peers are left out: an absent or incompatible optional peer is legitimate.
 */
function collectDependencyEdges(
  lock: BunLockFile,
  packages: Packages,
): Map<string, DependencyEdge> {
  const edges = new Map<string, DependencyEdge>()

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!isPackageEntry(entry)) continue

    const meta = packageEntryMeta(entry) ?? {}
    const optionalDependencies = normalizeDependencyMap(meta.optionalDependencies)
    const dependencies = {
      ...normalizeDependencyMap(meta.dependencies),
      ...optionalDependencies,
      ...normalizeDependencyMap(meta.peerDependencies),
    }
    const requesterPath = [...splitLockKey(lockKey).slice(0, -1), entry[0]]
    // A rewritten tuple brings its own version, so overrides scoped to a parent apply by the version in this lockfile.
    const requester = packageOverrideRequester(lock, entry[0])

    for (const [dependencyName, range] of Object.entries(dependencies)) {
      if (isOptionalPeerDependency(meta, dependencyName)) continue

      edges.set(`${lockKey}\0${dependencyName}`, {
        ...resolveEdge(
          lock,
          packages,
          { requesterLockKey: lockKey, resolutionContext: lockKey },
          requester,
          dependencyName,
          range,
        ),
        requesterSpec: entry[0],
        requesterPath,
        optional: Object.hasOwn(optionalDependencies, dependencyName),
      })
    }
  }

  for (const [workspacePath, workspace] of Object.entries(lock.workspaces ?? {})) {
    const workspaceName = workspace.name?.trim() || undefined
    const optionalDependencies = normalizeDependencyMap(workspace.optionalDependencies)
    const dependencies = {
      ...normalizeDependencyMap(workspace.dependencies),
      ...normalizeDependencyMap(workspace.devDependencies),
      ...optionalDependencies,
      ...normalizeDependencyMap(workspace.peerDependencies),
    }
    const label = workspaceName ?? (workspacePath ? `workspace:${workspacePath}` : "workspace:root")
    const requester = workspaceOverrideRequester(lock, workspacePath)

    for (const [dependencyName, range] of Object.entries(dependencies)) {
      edges.set(`workspace:${workspacePath}\0${dependencyName}`, {
        ...resolveEdge(
          lock,
          packages,
          { resolutionContext: workspaceName },
          requester,
          dependencyName,
          range,
        ),
        requesterSpec: workspacePath,
        requesterPath: [label],
        optional: Object.hasOwn(optionalDependencies, dependencyName),
      })
    }
  }

  return edges
}

function resolveEdge(
  lock: BunLockFile,
  packages: Packages,
  context: Pick<DependencyEdge, "requesterLockKey" | "resolutionContext">,
  requester: OverrideRequester,
  dependencyName: string,
  range: string,
) {
  const resolvedLockKey = resolveEdgeLockKey(packages, context, dependencyName)
  const resolvedEntry = resolvedLockKey === undefined ? undefined : packages[resolvedLockKey]
  return {
    ...context,
    dependencyName,
    range,
    overrideRange: dependencyOverrideRange(lock, requester, dependencyName, range),
    resolvedLockKey,
    resolvedSpec: isPackageEntry(resolvedEntry) ? resolvedEntry[0] : undefined,
  }
}

/**
 * Resolve an edge the way the duplicate analysis does.
 *
 * A workspace falls back to context-free lookup, which also accepts a unique nested entry.
 */
function resolveEdgeLockKey(
  packages: Packages,
  requester: Pick<DependencyEdge, "requesterLockKey" | "resolutionContext">,
  dependencyName: string,
): string | undefined {
  const resolvedLockKey = resolveDependencyLockKey(
    requester.resolutionContext,
    dependencyName,
    packages,
  )
  if (resolvedLockKey !== undefined || requester.requesterLockKey !== undefined) {
    return resolvedLockKey
  }
  return resolveDependencyLockKey(undefined, dependencyName, packages)
}

/**
 * Whether an edge resolves to another package, outside its effective range, or not at all while required.
 *
 * Bun rejects a lockfile with an unresolved required dependency whatever its specifier.
 */
function isConflict(edge: DependencyEdge): boolean {
  if (edge.resolvedSpec === undefined) return !edge.optional

  const resolved = parseResolvedSpec(edge.resolvedSpec)
  if (!resolved) return false

  const requirement = dependencyRequirement(edge.dependencyName, effectiveRequestRange(edge))
  return (
    resolved.name !== requirement.name ||
    evaluateRangeCompatibility(requirement.range, resolved.version) === false
  )
}

/**
 * Return the conflicting edges of the rewritten packages that the original packages did not have.
 *
 * An original conflict counts as kept only when the requester spec, the effective range, and the resolved spec are all
 * unchanged; any other conflict on the same edge is new.
 */
export function findNewConflicts(
  lock: BunLockFile,
  originalPackages: Packages,
  rewrittenPackages: Packages,
): DependencyEdge[] {
  const originalEdges = collectDependencyEdges(lock, originalPackages)
  const newConflicts: DependencyEdge[] = []

  for (const [id, edge] of collectDependencyEdges(lock, rewrittenPackages)) {
    if (!isConflict(edge)) continue

    const original = originalEdges.get(id)
    const isKept =
      original !== undefined &&
      original.requesterSpec === edge.requesterSpec &&
      effectiveRequestRange(original) === effectiveRequestRange(edge) &&
      original.resolvedSpec === edge.resolvedSpec
    if (!isKept) {
      newConflicts.push(edge)
    }
  }

  return newConflicts
}

/**
 * Return the rewrites, as `name@version`, that produced a new conflict.
 *
 * The analysis checks every inbound request of a rewritten version, so a new conflict comes from a changed requester
 * tuple, from a removed or replaced entry that the edge resolved to, or from a replaced entry that it resolves to now.
 */
export function findConflictCulprits(
  edge: DependencyEdge,
  originalPackages: Packages,
  rewrittenPackages: Packages,
  provenance: RewriteProvenance,
): Set<string> {
  const culprits = new Set<string>()
  const addCulprits = (lockKey: string) => {
    for (const rewriteKey of provenance.get(lockKey) ?? []) {
      culprits.add(rewriteKey)
    }
  }
  const isChanged = (lockKey: string) =>
    originalPackages[lockKey]?.[0] !== rewrittenPackages[lockKey]?.[0]

  if (edge.requesterLockKey !== undefined && isChanged(edge.requesterLockKey)) {
    addCulprits(edge.requesterLockKey)
  }
  const originalLockKey = resolveEdgeLockKey(originalPackages, edge, edge.dependencyName)
  if (originalLockKey !== undefined && isChanged(originalLockKey)) {
    addCulprits(originalLockKey)
  }
  if (edge.resolvedLockKey !== undefined && isChanged(edge.resolvedLockKey)) {
    addCulprits(edge.resolvedLockKey)
  }

  return culprits
}

/** Describe a conflicting edge for the report. */
export function toDependencyConflict(edge: DependencyEdge): DependencyConflict {
  return {
    requesterPath: edge.requesterPath,
    requesterLockKey: edge.requesterLockKey,
    dependencyName: edge.dependencyName,
    range: edge.range,
    overrideRange: edge.overrideRange,
    resolvedSpec: edge.resolvedSpec,
  }
}
