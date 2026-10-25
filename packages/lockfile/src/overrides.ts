import {
  type BunLockFile,
  BunLockFormatError,
  getOverrideRules,
  npmAliasTarget,
  type OverrideRules,
  type ScopedOverride,
  type SelectorRange,
  toSelectorRange,
} from "./parse"
import type { OverrideRequester } from "./requester"
import {
  isNpmRangeSpecifier,
  rangeIncludes,
  rangesIntersect,
  trimSpecifier,
} from "./selector-ranges"

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
 * Read the override that Bun applies to a dependency declaration, following Bun 1.4.4.
 *
 * A rule scoped to a parent applies to the direct dependencies of that parent only.
 * Among the matching scoped rules, a parent with a range wins over a parent without one,
 * which wins over no parent; within each of these, a rule whose target range matches wins.
 * An override by name applies when no scoped rule does.
 *
 * Bun never overrides an `npm:` alias of a semver range, unless a target range spells out the alias.
 * It overrides an alias of a dist-tag, such as `npm:debug@latest`, by the name of the aliased package,
 * so the override is returned as an alias of that package.
 */
export function dependencyOverrideRange(
  lock: Pick<BunLockFile, "overrides">,
  requester: OverrideRequester | undefined,
  dependencyName: string,
  declaredRange: string,
): string | undefined {
  const rules = getOverrideRules(lock.overrides)
  if (!rules) return undefined

  const alias = npmAliasTarget(trimSpecifier(declaredRange))
  if (!alias || !isDistTag(alias.range)) {
    return findOverride(rules, requester, dependencyName, declaredRange, alias !== undefined)
  }

  const override = findOverride(rules, requester, alias.name, declaredRange, false)
  if (override === undefined) return undefined
  // Bun reads the override under the aliased name, so a range keeps that package as the alias target,
  // while another alias or a source such as a git URL replaces the whole specifier.
  const requirement = dependencyRequirement(alias.name, override)
  return requirement.name !== alias.name || requirement.range.includes(":")
    ? override
    : `npm:${alias.name}@${requirement.range}`
}

/**
 * Return the value of the rule that Bun picks for a dependency looked up under `name`, if any.
 *
 * Throws `BunLockFormatError` when a rule that would outrank the picked one may apply,
 * but the tools cannot tell whether its ranges match.
 *
 * @param declaredRange The declared range, which an `npm:` alias of a dist-tag never lets a target range match.
 * @param isAlias Whether the declaration is an `npm:` alias that only a target range naming it can override.
 */
function findOverride(
  rules: OverrideRules,
  requester: OverrideRequester | undefined,
  name: string,
  declaredRange: string,
  isAlias: boolean,
): string | undefined {
  const scoped = rules.scopedByName.get(name) ?? []
  // Most dependencies have no scoped rule, so their declared range is not parsed.
  const declared = scoped.length ? toSelectorRange(declaredRange) : undefined
  let best: RankedRule | undefined
  let undecided: RankedRule | undefined

  for (const rule of scoped) {
    if (!rule.targetRange && isAlias) continue

    let tier = 0
    let isDecided = true
    if (rule.parent) {
      if (requester?.name === undefined || requester.name !== rule.parent.name) continue
      if (rule.parent.range) {
        if (requester.version === undefined) continue
        const includes = rangeIncludes(rule.parent.range, requester.version)
        if (includes === false) continue
        isDecided &&= includes === true
        tier = 4
      } else {
        tier = 2
      }
    }
    if (rule.targetRange) {
      const selects = declared ? rangeSelects(rule.targetRange, declared) : false
      if (selects === false) continue
      isDecided &&= selects === true
      tier += 1
    }
    const ranked = { rule, tier }
    if (!isDecided) {
      if (!undecided || outranks(ranked, undecided)) undecided = ranked
    } else if (!best || outranks(ranked, best)) {
      best = ranked
    }
  }

  if (undecided && (!best || outranks(undecided, best))) {
    throw new BunLockFormatError(
      `Cannot tell whether bun.lock override ${undecided.rule.key} applies to ${name} declared as ${JSON.stringify(declaredRange)}`,
    )
  }
  if (best) return best.rule.value
  // Only a key that spells out the alias, such as `name@npm:other@^1`, overrides an `npm:` alias.
  return isAlias ? undefined : rules.flat.get(name)
}

/**
 * Scoped rule with its precedence: a parent with a range 4, a parent without one 2, no parent 0,
 * plus 1 for a matching target range.
 */
type RankedRule = { rule: ScopedOverride; tier: number }

/** Whether a rule wins over another as Bun decides: by tier, then by the parent range text, then by the target range text. */
function outranks(left: RankedRule, right: RankedRule): boolean {
  if (left.tier !== right.tier) return left.tier > right.tier
  const leftParent = left.rule.parent?.range && left.rule.parent.rangeText
  const rightParent = right.rule.parent?.range && right.rule.parent.rangeText
  const order =
    (leftParent && rightParent ? compareText(leftParent, rightParent) : 0) ||
    compareText(left.rule.targetRangeText, right.rule.targetRangeText)
  return order < 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Whether an override key `name@range` selects a declaration, as npm and pnpm do: the two ranges overlap.
 *
 * Returns `undefined` when the tools cannot tell.
 */
function rangeSelects(range: SelectorRange, declared: SelectorRange): boolean | undefined {
  if (range.kind === "catalog" || declared.kind === "catalog") {
    return range.kind === "catalog" && declared.kind === "catalog" && isSameCatalog(range, declared)
  }
  // An alias key selects aliases of the same package, and a plain key never selects an alias.
  if (range.kind !== "semver" || range.alias !== declared.alias) return false
  return declared.kind === "semver" ? rangesIntersect(range.range, declared.range) : undefined
}

/** Whether two catalog references name the same catalog; `catalog:` and `catalog:default` are the default one. */
function isSameCatalog(left: { catalog: string }, right: { catalog: string }): boolean {
  const isDefault = (catalog: string) => catalog === "" || catalog === "default"
  return left.catalog === right.catalog || (isDefault(left.catalog) && isDefault(right.catalog))
}

/** Whether a version of an `npm:` alias is a dist-tag, such as `latest`, rather than a range or a source. */
function isDistTag(version: string): boolean {
  return /^[^\s:/#@|]+$/.test(version) && isNpmRangeSpecifier(version) === false
}

/**
 * Return the range Bun actually enforces for a dependency request.
 *
 * An override remains authoritative even when it is not valid semver;
 * compatibility then stays unknown instead of falling back to the declaration.
 */
export function effectiveDependencyRange(
  lock: Pick<BunLockFile, "overrides">,
  requester: OverrideRequester | undefined,
  dependencyName: string,
  declaredRange: string,
): string {
  const overrideRange = dependencyOverrideRange(lock, requester, dependencyName, declaredRange)
  return overrideRange === undefined ? declaredRange : overrideRange
}
