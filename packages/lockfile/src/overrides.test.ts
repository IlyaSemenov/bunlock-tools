import { describe, expect, test } from "bun:test"

import { dependencyRequirement, effectiveDependencyRange, npmAliasTarget } from "./overrides"

describe("npmAliasTarget", () => {
  test("reads the aliased package and range", () => {
    expect(npmAliasTarget("npm:debug@^4.3.0")).toEqual({ name: "debug", range: "^4.3.0" })
    expect(npmAliasTarget("npm:@types/ms@0.7.34")).toEqual({ name: "@types/ms", range: "0.7.34" })
    expect(npmAliasTarget("npm:x@^1.0.0")).toEqual({ name: "x", range: "^1.0.0" })
    expect(npmAliasTarget("npm:debug")).toEqual({ name: "debug", range: "*" })
    expect(npmAliasTarget("npm:debug@latest")).toEqual({ name: "debug", range: "latest" })
  })

  test("reads a versionless target that is also a valid range as a package name, as Bun does", () => {
    expect(npmAliasTarget("npm:x")).toEqual({ name: "x", range: "*" })
    expect(npmAliasTarget("npm:1")).toEqual({ name: "1", range: "*" })
    expect(npmAliasTarget("npm:1.x")).toEqual({ name: "1.x", range: "*" })
  })

  test("leaves ranges and other specifiers alone", () => {
    expect(npmAliasTarget("npm:^1.0.0")).toBeUndefined()
    expect(npmAliasTarget("npm:1.0.0")).toBeUndefined()
    expect(npmAliasTarget("npm:v1.0.0")).toBeUndefined()
    expect(npmAliasTarget("npm:>=1.0.0 <2.0.0")).toBeUndefined()
    expect(npmAliasTarget("^1.0.0")).toBeUndefined()
    expect(npmAliasTarget("workspace:*")).toBeUndefined()
  })
})

describe("dependencyRequirement", () => {
  test("requires the aliased package for an npm: alias", () => {
    expect(dependencyRequirement("dbg", "npm:debug@^4.3.0")).toEqual({
      name: "debug",
      range: "^4.3.0",
    })
  })

  test("requires the dependency itself for a range, with or without npm:", () => {
    expect(dependencyRequirement("debug", "npm:^4.3.0")).toEqual({ name: "debug", range: "^4.3.0" })
    expect(dependencyRequirement("debug", "^4.3.0")).toEqual({ name: "debug", range: "^4.3.0" })
  })
})

describe("effectiveDependencyRange", () => {
  const lock = { overrides: { debug: "4.3.3", dbg: "4.3.3" } }

  test("applies a bare-name override", () => {
    expect(effectiveDependencyRange(lock, "debug", "^4.3.0")).toBe("4.3.3")
    expect(effectiveDependencyRange(lock, "debug", "npm:^4.3.0")).toBe("4.3.3")
  })

  test("applies a bare-name override to a range after npm:", () => {
    expect(effectiveDependencyRange(lock, "debug", "npm:v4.3.0")).toBe("4.3.3")
  })

  test("keeps an npm: alias of a range, as Bun does not override it", () => {
    expect(effectiveDependencyRange(lock, "dbg", "npm:debug@^4.3.0")).toBe("npm:debug@^4.3.0")
    expect(effectiveDependencyRange(lock, "debug", "npm:debug@^4.3.0")).toBe("npm:debug@^4.3.0")
    expect(effectiveDependencyRange(lock, "dbg", "npm:debug")).toBe("npm:debug")
  })

  test("overrides an npm: alias of a dist-tag by the aliased package name", () => {
    expect(effectiveDependencyRange(lock, "dbg", "npm:debug@latest")).toBe("npm:debug@4.3.3")
    expect(effectiveDependencyRange(lock, "debug", "npm:debug@latest")).toBe("npm:debug@4.3.3")
    expect(
      effectiveDependencyRange({ overrides: { dbg: "4.3.3" } }, "dbg", "npm:debug@latest"),
    ).toBe("npm:debug@latest")
  })

  test("keeps the aliased package for an override written as a range after npm:", () => {
    const rangeAfterNpm = { overrides: { debug: "npm:^4.3.3" } }
    const otherAlias = { overrides: { debug: "npm:other@^1.0.0" } }

    expect(effectiveDependencyRange(rangeAfterNpm, "dbg", "npm:debug@latest")).toBe(
      "npm:debug@^4.3.3",
    )
    expect(effectiveDependencyRange(otherAlias, "dbg", "npm:debug@latest")).toBe("npm:other@^1.0.0")
  })
})
