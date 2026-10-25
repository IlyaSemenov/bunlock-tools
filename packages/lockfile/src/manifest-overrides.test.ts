import { describe, expect, test } from "bun:test"

import {
  findReplacedOverrideRules,
  readManifestOverrides,
  renderLockfileOverrides,
} from "./manifest-overrides"

const keepValue = (_target: string, value: string) => value

/** Returns the `bun.lock` `overrides` section for a `package.json` `overrides` field. */
function toLockfile(overrides: Record<string, unknown>) {
  return renderLockfileOverrides(readManifestOverrides(overrides, keepValue))
}

describe("readManifestOverrides", () => {
  test("reads selector keys, groups, and their children", () => {
    expect(
      readManifestOverrides(
        {
          "// note": "skipped",
          ms: "2.1.1",
          "ms@npm:^2": "2.1.2",
          "send@^0.18>debug": "2.6.8",
          "**/accepts/mime-types": "2.1.30",
          "@scope/pkg/@scope/dep": "1.0.0",
          express: { ".": "4.18.0", "qs@^6": "6.11.0", "// note": "skipped" },
        },
        keepValue,
      ),
    ).toEqual([
      { key: '"ms"', target: "ms", range: "", value: "2.1.1" },
      { key: '"ms@npm:^2"', target: "ms", range: "^2", value: "2.1.2" },
      {
        key: '"send@^0.18>debug"',
        parent: { name: "send", range: "^0.18" },
        target: "debug",
        range: "",
        value: "2.6.8",
      },
      {
        key: '"**/accepts/mime-types"',
        parent: { name: "accepts", range: "" },
        target: "mime-types",
        range: "",
        value: "2.1.30",
      },
      {
        key: '"@scope/pkg/@scope/dep"',
        parent: { name: "@scope/pkg", range: "" },
        target: "@scope/dep",
        range: "",
        value: "1.0.0",
      },
      { key: '"express" > "."', target: "express", range: "", value: "4.18.0" },
      {
        key: '"express" > "qs@^6"',
        parent: { name: "express", range: "" },
        target: "qs",
        range: "^6",
        value: "6.11.0",
      },
    ])
  })

  test("keeps the rule under its key when a value refers to another spec", () => {
    const rules = readManifestOverrides({ send: { ms: "$ms" } }, (target, value) =>
      value === `$${target}` ? "^2.1.0" : value,
    )

    expect(rules).toEqual([
      {
        key: '"send" > "ms"',
        parent: { name: "send", range: "" },
        target: "ms",
        range: "",
        value: "^2.1.0",
      },
    ])
  })

  test("rejects the rules that Bun skips", () => {
    const read = (overrides: Record<string, unknown>) => () =>
      readManifestOverrides(overrides, keepValue, "nested/package.json")

    expect(read({ "a/b/c": "1.0.0" })).toThrow(
      'nested/package.json override "a/b/c" nests deeper than one level, which Bun ignores',
    )
    expect(read({ "a>b>c": "1.0.0" })).toThrow('override "a>b>c" nests deeper than one level')
    expect(read({ a: { b: { c: "1.0.0" } } })).toThrow(
      'override "a" > "b" nests deeper than one level',
    )
    expect(read({ a: { "b>c": "1.0.0" } })).toThrow(
      'override "a" > "b>c" nests deeper than one level',
    )
    expect(read({ "@scope": "1.0.0" })).toThrow(
      'nested/package.json override "@scope" is not a package name with an optional semver range or a parent>name selector',
    )
    expect(read({ "x@": "1.0.0" })).toThrow('override "x@" is not a package name')
    // Bun reads a group key as a parent, so it takes neither a catalog nor an alias there.
    expect(read({ "x@catalog:": { ".": "1.0.0" } })).toThrow('override "x@catalog:" is not')
    expect(read({ "x@npm:y@^1": { z: "1.0.0" } })).toThrow('override "x@npm:y@^1" is not')
    expect(read({ a: "-" })).toThrow('override "a" has the value "-", which Bun ignores')
    expect(read({ a: "" })).toThrow('override "a" has the value "", which Bun ignores')
    expect(read({ a: "patch:a@1.0.0" })).toThrow('override "a" has the value "patch:a@1.0.0"')
    expect(read({ a: 1 })).toThrow('override "a" must be a string or an object of strings')
    expect(read({ a: { b: 1 } })).toThrow('override "a" > "b" must be a string')
  })
})

describe("findReplacedOverrideRules", () => {
  test("pairs rules that select the same packages under different keys", () => {
    const rules = readManifestOverrides(
      { d: "1.0.0", "**/d": "2.0.0", p: { q: "1.0.0", "**/q": "2.0.0" }, "p>q@^1": "3.0.0" },
      keepValue,
    )

    expect(findReplacedOverrideRules(rules).map(pair => pair.map(rule => rule.key))).toEqual([
      ['"d"', '"**/d"'],
      ['"p" > "q"', '"p" > "**/q"'],
    ])
  })
})

describe("renderLockfileOverrides", () => {
  test("writes only strings without scoped rules", () => {
    expect(toLockfile({ ms: "2.1.1", "**/debug": "4.3.4", accepts: "1.3.8" })).toEqual({
      accepts: "1.3.8",
      debug: "4.3.4",
      ms: "2.1.1",
    })
  })

  // Copied from the `bun.lock` that Bun 1.4.4 writes for the same `package.json`.
  test("groups scoped rules as Bun writes them", () => {
    const lockfile = toLockfile({
      ms: "2.1.1",
      "ms@^2": "2.1.2",
      "send>ms": "2.0.0",
      "send@^0.18>debug@^2": "2.6.8",
      "**/accepts/mime-types": "2.1.30",
      "@scope/pkg/dep": "1.0.0",
      express: { ".": "4.18.0", "body-parser": "1.20.0", "qs@^6": "6.11.0" },
      "debug@^2": { ".": "2.6.9", "ms@npm:^2": "2.0.0" },
      "zzz@npm:^1": "1.0.0",
      "cat@catalog:": "1.0.0",
      "al@npm:other@^1": "npm:other@1.2.0",
    })
    const expected = {
      "@scope/pkg": { dep: "1.0.0" },
      accepts: { "mime-types": "2.1.30" },
      "al@npm:other@^1": { ".": "npm:other@1.2.0" },
      "cat@catalog:": { ".": "1.0.0" },
      "debug@^2": { ".": "2.6.9", "ms@^2": "2.0.0" },
      express: { ".": "4.18.0", "body-parser": "1.20.0", "qs@^6": "6.11.0" },
      ms: "2.1.1",
      "ms@^2": { ".": "2.1.2" },
      send: { ms: "2.0.0" },
      "send@^0.18": { "debug@^2": "2.6.8" },
      "zzz@^1": { ".": "1.0.0" },
    }

    // Compares the text to check the order of keys too.
    expect(JSON.stringify(lockfile)).toBe(JSON.stringify(expected))
  })

  test("folds a rule by name into the unranged group of its package and orders groups by name, then range", () => {
    const lockfile = toLockfile({
      a: "1",
      "a@^1": "2",
      "a-b": { x: "1" },
      "a@^2": { y: "1" },
      b: { c: "1" },
      "b@^1": { ".": "3", "c@^2": "4", d: "5" },
    })

    expect(Object.entries(lockfile)).toEqual([
      ["a", "1"],
      ["a@^1", { ".": "2" }],
      ["a@^2", { y: "1" }],
      ["a-b", { x: "1" }],
      ["b", { c: "1" }],
      ["b@^1", { ".": "3", "c@^2": "4", d: "5" }],
    ])
    expect(toLockfile({ a: "1", "a>b": "2" })).toEqual({ a: { ".": "1", b: "2" } })
  })

  test("keeps a rule for a package named like an object property", () => {
    const lockfile = toLockfile(JSON.parse('{ "p": { "__proto__": "1.0.0" } }'))

    expect(JSON.stringify(lockfile)).toBe('{"p":{"__proto__":"1.0.0"}}')
  })

  test("keeps the later of two rules that select the same packages", () => {
    expect(toLockfile({ d: "1", "**/d": "2", p: { q: "1" }, "p>q": "2", "q@^1": "3" })).toEqual({
      d: "2",
      p: { q: "2" },
      "q@^1": { ".": "3" },
    })
  })
})
