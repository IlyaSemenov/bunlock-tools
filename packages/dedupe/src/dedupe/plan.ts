import { type BunLockFile, parseBunLock, renderBunLock } from "bunlock-lockfile"

import {
  classifyDuplicatePackages,
  type DependencyConflict,
  type DuplicatePackageInfo,
} from "./analyze"
import { findConflictCulprits, findNewConflicts, toDependencyConflict } from "./conflicts"
import {
  collectVersionRewrites,
  pruneUnreachableEntries,
  rewriteEntries,
  type RewriteProvenance,
} from "./rewrite"

/** Summary returned by the text-level lockfile rewrite API. */
export type DedupeLockResult = {
  /** True when returned `lockText` should replace the input. */
  changed: boolean
  lockText: string
  /** Total entries touched; equals `rewrittenEntries + prunedEntries`. */
  touchedEntries: number
  /** Number of entries touched by dedupe rewrites across all passes. */
  rewrittenEntries: number
  /** Number of unreachable package entries removed across all passes. */
  prunedEntries: number
  /** Number of distinct package names directly rewritten for deduplication. */
  rewrittenPackages: number
}

type DedupePasses = {
  /** Rewritten copy of the input lockfile. */
  lock: BunLockFile
  provenance: RewriteProvenance
  rewrittenEntries: number
  prunedEntries: number
  touchedPackageNames: Set<string>
}

type DedupePlan = DedupePasses & {
  /** Dependency conflicts of the package versions whose rewrite is held back, keyed by `name@version`. */
  heldBack: Map<string, DependencyConflict[]>
}

/**
 * Rewrite and prune a copy of the lockfile until a pass changes nothing.
 *
 * The fixed-point loop is intentional: rewrites and standalone unreachable
 * pruning can each change the graph enough to unlock another dedupe pass.
 */
function runDedupePasses(
  lock: BunLockFile,
  heldBack: ReadonlyMap<string, DependencyConflict[]>,
): DedupePasses {
  const packages = { ...lock.packages }
  const rewritten: BunLockFile = { ...lock, packages }
  const provenance: RewriteProvenance = new Map()
  let rewrittenEntries = 0
  let prunedEntries = 0
  const touchedPackageNames = new Set<string>()

  for (let pass = 0; pass < 50; pass += 1) {
    const rewrites = collectVersionRewrites(classifyDuplicatePackages(rewritten, heldBack))
    const rewriteResult = rewriteEntries(rewritten, packages, rewrites, provenance)
    const passPrunedEntries = pruneUnreachableEntries(rewritten, packages)
    if (rewriteResult.touchedEntries + passPrunedEntries === 0) break

    rewrittenEntries += rewriteResult.touchedEntries
    prunedEntries += passPrunedEntries
    for (const name of rewriteResult.touchedPackageNames) {
      touchedPackageNames.add(name)
    }
  }

  return { lock: rewritten, provenance, rewrittenEntries, prunedEntries, touchedPackageNames }
}

/**
 * Plan the dedupe of a lockfile: every pass, with the rewrites that would break dependencies held back.
 *
 * Intermediate passes may leave a dependency outside its range for a later pass to fix, so only the final result is
 * checked against the input.
 * Each new conflict holds back the rewrites that produced it, and the passes run again from the input.
 * The loop ends because the held-back set grows on every retry.
 */
function planDedupe(lock: BunLockFile): DedupePlan {
  const originalPackages = lock.packages ?? {}
  const heldBack = new Map<string, DependencyConflict[]>()

  while (true) {
    const passes = runDedupePasses(lock, heldBack)
    const conflicts = findNewConflicts(lock, originalPackages, passes.lock.packages ?? {})
    if (conflicts.length === 0) {
      return { ...passes, heldBack }
    }

    const culprits = new Map<string, DependencyConflict[]>()
    for (const edge of conflicts) {
      for (const rewriteKey of findConflictCulprits(
        edge,
        originalPackages,
        passes.lock.packages ?? {},
        passes.provenance,
      )) {
        culprits.set(rewriteKey, [...(culprits.get(rewriteKey) ?? []), toDependencyConflict(edge)])
      }
    }
    if (culprits.size === 0) {
      // No recorded rewrite explains the conflicts, so every rewrite of this attempt is held back.
      for (const rewriteKeys of passes.provenance.values()) {
        for (const rewriteKey of rewriteKeys) {
          culprits.set(rewriteKey, conflicts.map(toDependencyConflict))
        }
      }
    }
    if (culprits.size === 0) {
      // Pruning alone cannot be held back; keep the input unchanged instead of writing the conflicts.
      return {
        lock,
        provenance: new Map(),
        rewrittenEntries: 0,
        prunedEntries: 0,
        touchedPackageNames: new Set(),
        heldBack,
      }
    }

    for (const [rewriteKey, dependencyConflicts] of culprits) {
      heldBack.set(rewriteKey, dependencyConflicts)
    }
  }
}

/**
 * Analyze duplicate package versions and classify which versions can be
 * rewritten safely using only entries already present in the lockfile.
 */
export function analyzeDuplicatePackages(lock: BunLockFile): DuplicatePackageInfo[] {
  return classifyDuplicatePackages(lock, planDedupe(lock).heldBack)
}

/**
 * Parse, rewrite, prune, and render a bun.lock string.
 *
 * @param lockText Raw `bun.lock` text, not a parsed object, so the full
 * parse/rewrite/render path is exercised.
 */
export function dedupeLockText(lockText: string): DedupeLockResult {
  const plan = planDedupe(parseBunLock(lockText))
  const touchedEntries = plan.rewrittenEntries + plan.prunedEntries

  if (touchedEntries === 0) {
    return {
      changed: false,
      lockText,
      touchedEntries: 0,
      rewrittenEntries: 0,
      prunedEntries: 0,
      rewrittenPackages: 0,
    }
  }

  return {
    changed: true,
    lockText: renderBunLock(plan.lock),
    touchedEntries,
    rewrittenEntries: plan.rewrittenEntries,
    prunedEntries: plan.prunedEntries,
    rewrittenPackages: plan.touchedPackageNames.size,
  }
}
