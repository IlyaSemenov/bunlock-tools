import { describe, expect, test } from "bun:test"

import { parseBunRange, rangeIncludes, rangesIntersect } from "./selector-ranges"

const parse = (text: string) => parseBunRange(text)!

describe("parseBunRange", () => {
  test("rejects a range that node-semver cannot parse", () => {
    expect(parseBunRange("01.2.3")).toBeUndefined()
    expect(parseBunRange("^16 | ^18")).toBeUndefined()
    expect(parseBunRange("latest")).toBeUndefined()
  })
})

describe("rangeIncludes", () => {
  test("evaluates each alternative on its own, as Bun does", () => {
    expect(rangeIncludes(parse("1.2.3-beta || *"), "1.2.3-beta")).toBe(true)
    expect(rangeIncludes(parse("^1.0.0 ||"), "2.0.0")).toBe(false)
  })

  test("cannot tell for a prerelease of 0.0.0, which the lower bound >=0.0.0 that node-semver drops excludes", () => {
    expect(rangeIncludes(parse(">=0.0.0 <=0.0.0-beta"), "0.0.0-alpha")).toBeUndefined()
    expect(rangeIncludes(parse(">=0.0.0 <=0.0.0-beta"), "0.0.0")).toBe(false)
  })
})

test("rangesIntersect", () => {
  // Expected values follow Bun's `Group::intersects`.
  const cases: [string, string, boolean | undefined][] = [
    ["^1.0.0", "^1.2.0", true],
    ["^1.0.0", "^2.0.0", false],
    ["2.1.2", "^2.0.0", true],
    ["2.1.2", "^2.1.3", false],
    ["1.x || ^3", "3.1.0", true],
    ["<0", "*", false],
    ["*", "*", true],
    // An exact prerelease goes through `satisfies`, where `*` admits it too.
    ["^1.2.3-alpha", "1.2.3-beta", true],
    ["^1.2.0", "1.2.3-beta", false],
    ["*", "1.2.3-beta", true],
    // Only an alternative written as one comparator is an exact version or `*`.
    ["* *", "1.2.3-beta", false],
    ["1.2.3-beta 1.2.3-beta", "^1.0.0", true],
    ["1.2.3-dev 1.2.3-dev", "^1.0.0", true],
    ["= 1.2.3-beta", "^1.0.0", false],
    // Two ranges compare only their bounds.
    [">=1.0.0 <2.0.0", ">=2.0.0-alpha <2.0.0", true],
    [">=1.0.0 <2.0.0", ">=2.0.0", false],
    [">1.0.0", "<=1.0.0", false],
    [">=1.0.0", "<=1.0.0", true],
    // A lower bound `>=0.0.0` that node-semver drops matters only below 0.0.0, where the answer is unknown.
    [">=0.0.0 <0.0.0", ">=0.0.0-alpha <0.0.0", undefined],
    [">=0.0.0 >=0.0.0-alpha <=0.0.0-beta", ">=0.0.0-alpha <0.0.0", undefined],
    ["0.x", "<0.0.0", undefined],
    ["0.x", "<=0.0.0", true],
  ]
  for (const [left, right, expected] of cases) {
    expect([left, right, rangesIntersect(parse(left), parse(right))]).toEqual([
      left,
      right,
      expected,
    ])
    expect([right, left, rangesIntersect(parse(right), parse(left))]).toEqual([
      right,
      left,
      expected,
    ])
  }
})
