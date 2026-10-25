import {
  type BunLockFile,
  isParentSegment,
  type OverrideSegment,
  parseOverrideSegment,
} from "./parse"

/** Override rule of a `package.json` `overrides` field. */
export type ManifestOverrideRule = {
  /** The rule as written in `package.json`, such as `"send>ms"` or `"send" > "ms"`, for messages. */
  key: string
  parent?: { name: string; range: string }
  target: string
  /** Target range as Bun records it; empty without a range. */
  range: string
  value: string
}

/** Selector of a string rule: a target, optionally with a parent. */
type Selector = { parent?: OverrideSegment; target: OverrideSegment }

/**
 * Read the rules of a `package.json` `overrides` field, as Bun 1.4.4 does.
 *
 * A string value is a rule under a selector key: `name`, `name@range`, `parent>name`, or `parent/name`.
 * An object value is a group under the key `name` or `name@range`: its `"."` child overrides that package itself,
 * and any other child `dep` or `dep@range` overrides a dependency of it.
 * `resolveValue` returns the spec that a `$name` value refers to; the rule stays under its key.
 * Throws on a rule that Bun skips with a warning for its key, its nesting, or its value type,
 * on the values `""`, `-`, and `patch:…`, which Bun skips too, and on a range the tools cannot evaluate.
 * Does not detect a value that Bun skips because it cannot parse it as a dependency spec, such as a malformed git URL.
 */
export function readManifestOverrides(
  overrides: Record<string, unknown>,
  resolveValue: (target: string, value: string) => string,
  source = "package.json",
): ManifestOverrideRule[] {
  const rules: ManifestOverrideRule[] = []
  const fail = (key: string, problem: string) => new Error(`${source} override ${key} ${problem}`)
  const failSelector = (key: string) =>
    fail(key, "is not a package name with an optional semver range or a parent>name selector")
  const failDepth = (key: string) => fail(key, "nests deeper than one level, which Bun ignores")
  const addRule = (
    key: string,
    parent: OverrideSegment | undefined,
    target: OverrideSegment,
    value: unknown,
  ) => {
    // A top-level value is checked before, so only a group child gets here with another type.
    if (typeof value !== "string") {
      throw fail(key, "must be a string")
    }
    if (parent && !isParentSegment(parent)) {
      throw failSelector(key)
    }
    if (!value || value === "-" || value.startsWith("patch:")) {
      throw fail(key, `has the value ${JSON.stringify(value)}, which Bun ignores`)
    }
    rules.push({
      key,
      parent: parent && { name: parent.name, range: parent.range },
      target: target.name,
      range: target.range,
      value: resolveValue(target.name, value),
    })
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (isCommentKey(key)) continue
    const label = JSON.stringify(key)
    if (!isRecord(value)) {
      if (typeof value !== "string") throw fail(label, "must be a string or an object of strings")
      const selector = parseSelector(key)
      if (selector === "too-deep") throw failDepth(label)
      if (!selector) throw failSelector(label)
      addRule(label, selector.parent, selector.target, value)
      continue
    }

    // A group key is a single segment: Bun does not read selectors there.
    // Bun reads it as a parent even for the `"."` child, so it takes only a parent range.
    const group = parseOverrideSegment(key)
    if (!group || !isParentSegment(group)) throw failSelector(label)
    for (const [childKey, childValue] of Object.entries(value)) {
      if (isCommentKey(childKey)) continue
      const childLabel = `${label} > ${JSON.stringify(childKey)}`
      if (isRecord(childValue)) throw failDepth(childLabel)
      if (childKey === ".") {
        addRule(childLabel, undefined, group, childValue)
        continue
      }
      const selector = parseSelector(childKey)
      if (selector === "too-deep" || selector?.parent) throw failDepth(childLabel)
      if (!selector) throw failSelector(childLabel)
      addRule(childLabel, group, selector.target, childValue)
    }
  }
  return rules
}

/**
 * Return the pairs of rules where a later rule replaces an earlier one, because both select the same packages.
 *
 * Bun keeps the later rule of such a pair, so the result depends on the order of the keys.
 */
export function findReplacedOverrideRules(
  rules: ManifestOverrideRule[],
): [ManifestOverrideRule, ManifestOverrideRule][] {
  const seen = new Map<string, ManifestOverrideRule>()
  const pairs: [ManifestOverrideRule, ManifestOverrideRule][] = []
  for (const rule of rules) {
    const identity = getRuleIdentity(rule)
    const earlier = seen.get(identity)
    if (earlier) pairs.push([earlier, rule])
    seen.set(identity, rule)
  }
  return pairs
}

/**
 * Return the `bun.lock` `overrides` section for the rules, as Bun 1.4.4 writes it.
 *
 * Without scoped rules, every rule is a string by package name.
 * Otherwise rules are grouped under `name` or `name@range` keys:
 * a rule without a parent is the `"."` of its group, and a rule with a parent is a child of the parent's group.
 * A rule by name stays a string unless its package has an unranged group.
 */
export function renderLockfileOverrides(
  rules: ManifestOverrideRule[],
): NonNullable<BunLockFile["overrides"]> {
  const flat = new Map<string, string>()
  const scoped = new Map<string, ManifestOverrideRule>()
  for (const rule of rules) {
    // Like Bun, a later rule replaces an earlier one with the same identity.
    if (!rule.parent && !rule.range) flat.set(rule.target, rule.value)
    else scoped.set(getRuleIdentity(rule), rule)
  }
  if (!scoped.size) {
    return Object.fromEntries([...flat].sort(([a], [b]) => compareText(a, b)))
  }

  type Group = { name: string; range: string; dot?: string; children: ManifestOverrideRule[] }
  const groups = new Map<string, Group>()
  const getGroup = (name: string, range: string) => {
    const id = JSON.stringify([name, range])
    let group = groups.get(id)
    if (!group) {
      group = { name, range, children: [] }
      groups.set(id, group)
    }
    return group
  }
  for (const rule of scoped.values()) {
    if (rule.parent) getGroup(rule.parent.name, rule.parent.range).children.push(rule)
    else getGroup(rule.target, rule.range).dot = rule.value
  }

  const entries: { name: string; range: string; value: string | Record<string, string> }[] = []
  for (const [name, value] of flat) {
    const group = groups.get(JSON.stringify([name, ""]))
    if (group) group.dot = value
    else entries.push({ name, range: "", value })
  }
  for (const { name, range, dot, children } of groups.values()) {
    children.sort((a, b) => compareText(a.target, b.target) || compareText(a.range, b.range))
    // Built from entries, so a child such as `__proto__` stays an own key.
    const value = Object.fromEntries([
      ...(dot === undefined ? [] : [[".", dot]]),
      ...children.map(child => [toSelectorKey(child.target, child.range), child.value]),
    ])
    entries.push({ name, range, value })
  }
  entries.sort((a, b) => compareText(a.name, b.name) || compareText(a.range, b.range))
  return Object.fromEntries(
    entries.map(entry => [toSelectorKey(entry.name, entry.range), entry.value]),
  )
}

/** Return the key that Bun matches a rule by when it replaces an earlier rule. */
function getRuleIdentity({ parent, target, range }: ManifestOverrideRule): string {
  return JSON.stringify([target, range, parent?.name, parent?.range])
}

function toSelectorKey(name: string, range: string): string {
  return range ? `${name}@${range}` : name
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isCommentKey(key: string): boolean {
  return key.startsWith("//")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse the selector key of a string rule, as Bun's `parse_selector` does.
 *
 * Returns `"too-deep"` for a selector with more than one parent, which Bun skips,
 * and `undefined` for any other selector that Bun skips or the tools cannot evaluate.
 */
function parseSelector(key: string): Selector | "too-deep" | undefined {
  const delimiter = findPnpmDelimiter(key)
  if (delimiter !== undefined) {
    const parentText = key.slice(0, delimiter).trim()
    const targetText = key.slice(delimiter + 1).trim()
    if (!targetText) return undefined
    if (findPnpmDelimiter(targetText) !== undefined) return "too-deep"
    const parent = parseOverrideSegment(parentText)
    const target = parseOverrideSegment(targetText)
    return parent && target && { parent, target }
  }

  const segments = splitYarnPath(key)
  if (typeof segments === "string" || !segments) return segments
  const parsed = segments.map(segment => parseOverrideSegment(segment))
  if (parsed.some(segment => !segment)) return undefined
  const [first, second] = parsed as OverrideSegment[]
  return second ? { parent: first, target: second } : { target: first! }
}

/**
 * Return the position of the pnpm `parent>name` delimiter: the first `>` that does not follow a space, `|`, `@`, or `:`.
 *
 * Those characters put the `>` into a range, such as `name@>=1` or `name@npm:>=1`.
 */
function findPnpmDelimiter(key: string): number | undefined {
  for (let index = key.indexOf(">", 1); index !== -1; index = key.indexOf(">", index + 1)) {
    if (!" |@:".includes(key[index - 1]!)) return index
  }
  return undefined
}

/**
 * Split a yarn `parent/name` path into at most two segments, as Bun's `parse_yarn_path` does.
 *
 * `**` segments are skipped, a scope joins the name after it, and the alias target in `name@npm:@scope/other`
 * stays in its segment.
 */
function splitYarnPath(key: string): string[] | "too-deep" | undefined {
  const tokens = key.split("/")
  const segments: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const isLast = index === tokens.length - 1
    if (!token || (token === "**" && isLast)) return undefined
    if (token === "**") continue

    let segment = token
    if (token.startsWith("@")) {
      const name = tokens[++index]
      if (!name) return undefined
      segment += `/${name}`
    }
    if (segment.includes("@npm:@") && index < tokens.length - 1) {
      segment += `/${tokens[++index]}`
    }
    if (segments.length === 2) return "too-deep"
    segments.push(segment)
  }
  return segments.length ? segments : undefined
}
