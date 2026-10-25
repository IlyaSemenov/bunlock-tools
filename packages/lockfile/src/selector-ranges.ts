import semver from "semver"

/** A semver range whose `||` alternatives are parsed one by one, as Bun evaluates them. */
export type BunRange = { alternatives: Alternative[] }

type Alternative = {
  range: semver.Range
  comparators: readonly semver.Comparator[]
  /**
   * Whether the alternative is written as one comparator, such as `1.2.3` or `*`.
   *
   * Bun treats an alternative as an exact version or as `*` only then, while node-semver also merges repeated
   * comparators, such as `* *`.
   */
  isSingle: boolean
}

type Bound = { version: semver.SemVer; inclusive: boolean }
type Interval = { lower?: Bound; upper?: Bound }

/** The lowest version: an interval without a lower bound starts there. */
const lowestVersion = new semver.SemVer("0.0.0-0")
const zeroVersion = new semver.SemVer("0.0.0")

/** Remove the leading whitespace that Bun's `trim_literal` removes from a specifier before reading it. */
export function trimSpecifier(specifier: string): string {
  return specifier.replace(/^[ \t\n\r]+/, "")
}

/** Prefixes of specifiers that Bun reads as a path, a URL, or another protocol, never as a version range. */
const nonRangePrefixes = [
  "./",
  "../",
  "/",
  "~/",
  "file:",
  "link:",
  "workspace:",
  "catalog:",
  "npm:",
  "git+",
  "git:",
  "github:",
  "http:",
  "https:",
  "ssh:",
]

/** Whether Bun reads a specifier as a tarball by its file extension. */
function isTarballSpecifier(specifier: string): boolean {
  const lowerCase = specifier.toLowerCase()
  return [".tgz", ".tar.gz", ".tar"].some(extension => lowerCase.endsWith(extension))
}

/**
 * Tell whether Bun reads a specifier as an npm version range, following the branches of its `Tag::infer`.
 *
 * Returns `undefined` when the answer depends on details that are not ported.
 */
export function isNpmRangeSpecifier(specifier: string): boolean | undefined {
  const text = trimSpecifier(specifier)
  if (!text) return false

  const first = text[0]!
  // An operator, `*`, or `|`, as in `>=1`, `^1.2.3`, or `|| 1.x`.
  if ("=><^*|".includes(first)) return true
  // `~1.2.3`, but not the home-directory path `~/pkg`.
  if (first === "~") return !text.startsWith("~/")
  // `x`, `X`, `x.1`, but not a word such as `xyz`.
  if ((first === "x" || first === "X") && (text.length === 1 || text[1] === ".")) return true
  if (text.startsWith("patch:")) return true

  // `1.2.3` or `v1.2.3`: Bun reads such text as a dist-tag when it is a word that only starts like a version,
  // such as `2x`, so only text that node-semver parses is known to be a range.
  if (/^v?\d/.test(text)) {
    if (isTarballSpecifier(text)) return false
    return parseBunRange(text) ? true : undefined
  }
  // Any other `v...` is a dist-tag, such as `vnext`.
  if (first === "v" || first === ".") return false
  if (nonRangePrefixes.some(prefix => text.startsWith(prefix))) return false
  // A Windows drive path, such as `C:/pkg`.
  if (/^[a-z]:\//i.test(text)) return false

  // Any other text is a dist-tag, unless it contains `|`, which makes it a range.
  // Text with `/` or `:` may instead be a GitHub shorthand or a git path, whose checks are not ported.
  if (!text.includes("|")) return false
  if (isTarballSpecifier(text) || text.includes("/") || text.includes(":")) return undefined
  return true
}

/**
 * Parse a semver range for override selectors, or return `undefined` when node-semver cannot parse it,
 * although Bun may read it, such as `01.2.3`.
 *
 * Bun expands comparators as node-semver does, but it evaluates every `||` alternative on its own, so node-semver's
 * normalizations across alternatives are avoided, and it skips an empty alternative.
 */
export function parseBunRange(text: string): BunRange | undefined {
  const alternatives: Alternative[] = []
  for (const alternativeText of text.split("||").filter(part => part.trim())) {
    let range: semver.Range
    try {
      range = new semver.Range(alternativeText)
    } catch {
      return undefined
    }
    alternatives.push({
      range,
      comparators: range.set[0]!,
      isSingle: countComparatorTokens(alternativeText) === 1,
    })
  }
  return alternatives.length ? { alternatives } : undefined
}

/** Count the comparators written in an alternative, such as 2 in `>=1.0.0 <2.0.0`. */
function countComparatorTokens(alternativeText: string): number {
  const compacted = alternativeText
    .trim()
    // An operator at the start of a comparator may be followed by spaces, as in `>= 1.2.3`.
    .replace(/(^|\s)([<>]=?|=|~>?|\^|v)\s+/g, "$1$2")
    // A hyphen range, such as `1 - 2`, is one comparator.
    .replace(/\s+-\s+/g, "-")
  return compacted.split(/\s+/).length
}

/**
 * Bun keeps a lower bound `>=0.0.0` that node-semver drops while parsing, such as the one of `0.x`.
 * Adding that bound to an alternative only narrows it, so an answer computed both without it and with it in every
 * alternative is Bun's answer when the two agree, and is unknown otherwise.
 */
function evaluateWithZeroFloor(evaluate: (hasZeroFloor: boolean) => boolean): boolean | undefined {
  const withoutFloor = evaluate(false)
  return withoutFloor === evaluate(true) ? withoutFloor : undefined
}

/** Tell whether a version satisfies a range, as Bun's `Group::satisfies` does, or `undefined` when unknown. */
export function rangeIncludes(range: BunRange, version: string): boolean | undefined {
  return evaluateWithZeroFloor(hasZeroFloor =>
    range.alternatives.some(alternative => alternativeIncludes(alternative, version, hasZeroFloor)),
  )
}

function alternativeIncludes(
  alternative: Alternative,
  version: string | semver.SemVer,
  hasZeroFloor: boolean,
): boolean {
  return (
    alternative.range.test(version) && (!hasZeroFloor || semver.compare(version, zeroVersion) >= 0)
  )
}

/**
 * Tell whether some version satisfies both ranges, as Bun 1.4.4 matches a scoped override key `name@range`
 * against a declared range, or `undefined` when unknown.
 *
 * Ports Bun's `Group::intersects`: an exact version goes through `satisfies`, where `*` admits a prerelease too,
 * and two ranges compare only their bounds, so `>=1.0.0 <2.0.0` intersects `>=2.0.0-alpha <2.0.0`.
 */
export function rangesIntersect(left: BunRange, right: BunRange): boolean | undefined {
  return evaluateWithZeroFloor(hasZeroFloor => {
    if (
      admitsExactVersionOf(left, right, hasZeroFloor) ||
      admitsExactVersionOf(right, left, hasZeroFloor)
    ) {
      return true
    }
    const isRange = (alternative: Alternative) => exactVersion(alternative) === undefined
    for (const leftAlternative of left.alternatives.filter(isRange)) {
      const base = narrow({}, leftAlternative, hasZeroFloor)
      if (!isNonEmpty(base)) continue
      for (const rightAlternative of right.alternatives.filter(isRange)) {
        if (isNonEmpty(narrow(base, rightAlternative, hasZeroFloor))) return true
      }
    }
    return false
  })
}

function isAny(comparator: semver.Comparator): boolean {
  return comparator.value === ""
}

function exactVersion({ comparators, isSingle }: Alternative): semver.SemVer | undefined {
  const [comparator] = comparators
  return isSingle &&
    comparators.length === 1 &&
    !isAny(comparator!) &&
    (comparator!.operator === "" || comparator!.operator === "=")
    ? comparator!.semver
    : undefined
}

/** Whether an alternative is `*`, which Bun reads as a lone `>=0.0.0`. */
function isStar({ comparators, isSingle }: Alternative): boolean {
  return isSingle && comparators.length === 1 && isAny(comparators[0]!)
}

function admitsExactVersionOf(range: BunRange, other: BunRange, hasZeroFloor: boolean): boolean {
  return other.alternatives.some(alternative => {
    const version = exactVersion(alternative)
    return (
      version !== undefined &&
      (range.alternatives.some(candidate =>
        alternativeIncludes(candidate, version, hasZeroFloor),
      ) ||
        (version.prerelease.length > 0 && range.alternatives.some(isStar)))
    )
  })
}

function narrow(interval: Interval, alternative: Alternative, hasZeroFloor: boolean): Interval {
  const result = { ...interval }
  if (hasZeroFloor) raise(result, { version: zeroVersion, inclusive: true })
  for (const comparator of alternative.comparators) {
    if (isAny(comparator)) {
      raise(result, { version: zeroVersion, inclusive: true })
      continue
    }
    const { operator, semver: version } = comparator
    if (operator === "" || operator === "=") {
      raise(result, { version, inclusive: true })
      cap(result, { version, inclusive: true })
    } else if (operator.startsWith(">")) {
      raise(result, { version, inclusive: operator === ">=" })
    } else {
      cap(result, { version, inclusive: operator === "<=" })
    }
  }
  return result
}

function raise(interval: Interval, bound: Bound): void {
  const order = interval.lower ? semver.compare(bound.version, interval.lower.version) : 1
  if (order > 0 || (order === 0 && !bound.inclusive)) interval.lower = bound
}

function cap(interval: Interval, bound: Bound): void {
  const order = interval.upper ? semver.compare(bound.version, interval.upper.version) : -1
  if (order < 0 || (order === 0 && !bound.inclusive)) interval.upper = bound
}

function isNonEmpty({ lower, upper }: Interval): boolean {
  if (!upper) return true
  const from = lower ?? { version: lowestVersion, inclusive: true }
  const order = semver.compare(from.version, upper.version)
  return order < 0 || (order === 0 && from.inclusive && upper.inclusive)
}
