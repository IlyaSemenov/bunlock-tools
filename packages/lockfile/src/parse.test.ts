import { describe, expect, test } from "bun:test"

import {
  BunLockFormatError,
  needsLockfileVersion1,
  npmAliasTarget,
  parseBunLock,
  parseResolvedSpec,
} from "./parse"

describe("parseResolvedSpec", () => {
  test("splits registry specs, including scoped names", () => {
    expect(parseResolvedSpec("ms@2.1.3")).toEqual({ name: "ms", version: "2.1.3" })
    expect(parseResolvedSpec("@types/ms@0.7.34")).toEqual({ name: "@types/ms", version: "0.7.34" })
  })

  test("keeps an @ inside the source as part of the version", () => {
    expect(parseResolvedSpec("parent@git+ssh://git@example.com/team/repo.git#abc123")).toEqual({
      name: "parent",
      version: "git+ssh://git@example.com/team/repo.git#abc123",
    })
    expect(
      parseResolvedSpec("@types/debug@https://registry.npmjs.org/@types/debug/-/debug-4.1.12.tgz"),
    ).toEqual({
      name: "@types/debug",
      version: "https://registry.npmjs.org/@types/debug/-/debug-4.1.12.tgz",
    })
    expect(parseResolvedSpec("@scope/p@workspace:packages/@scope/p")).toEqual({
      name: "@scope/p",
      version: "workspace:packages/@scope/p",
    })
    expect(parseResolvedSpec("local@file:../vendor/@scope/local")).toEqual({
      name: "local",
      version: "file:../vendor/@scope/local",
    })
  })

  test("splits github shorthand sources", () => {
    expect(parseResolvedSpec("html2canvas@github:hakimio/html2canvas#258fdea")).toEqual({
      name: "html2canvas",
      version: "github:hakimio/html2canvas#258fdea",
    })
  })

  test("rejects a spec without a version", () => {
    expect(parseResolvedSpec("ms")).toBeNull()
    expect(parseResolvedSpec("ms@")).toBeNull()
    expect(parseResolvedSpec("@types/ms")).toBeNull()
  })
})

describe("needsLockfileVersion1", () => {
  const integrity = `sha512-${"A".repeat(86)}==`

  test("accepts at later versions an npm package with a supported integrity or from the default registry, and a workspace", () => {
    expect(needsLockfileVersion1(["ms@2.1.3", "", {}, integrity])).toBe(false)
    expect(needsLockfileVersion1(["ms@2.1.3", "", {}, ""])).toBe(false)
    expect(
      needsLockfileVersion1(["ms@2.1.3", "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", {}, ""]),
    ).toBe(false)
    expect(
      needsLockfileVersion1(["ms@2.1.3", "https://example.com/ms-2.1.3.tgz", {}, integrity]),
    ).toBe(false)
    expect(needsLockfileVersion1(["w@workspace:packages/w"])).toBe(false)
  })

  test("requires version 1 for an unsupported integrity, and for a tarball outside the default registry without an integrity", () => {
    expect(needsLockfileVersion1(["ms@2.1.3", "", {}, "md5-abc"])).toBe(true)
    expect(needsLockfileVersion1(["ms@2.1.3", "https://example.com/ms-2.1.3.tgz", {}, ""])).toBe(
      true,
    )
    expect(
      needsLockfileVersion1(["ms@2.1.3", "https://registry.npmjs.org.example.com/ms.tgz", {}, ""]),
    ).toBe(true)
  })

  test("requires version 1 for an unsafe checkout tag of a git package, but not of a GitHub package, which Bun rejects at every version", () => {
    expect(needsLockfileVersion1(["x@git+https://example.com/x.git#abc", {}, "x-abc"])).toBe(false)
    expect(needsLockfileVersion1(["x@git+https://example.com/x.git#abc", {}, "../x"])).toBe(true)
    expect(needsLockfileVersion1(["x@github:owner/x#abc", {}, "../x"])).toBe(false)
  })
})

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

describe("parseBunLock", () => {
  const parseOverrides = (overrides: unknown) =>
    parseBunLock(JSON.stringify({ lockfileVersion: 3, overrides })).overrides

  test("accepts overrides by name and groups of scoped rules", () => {
    const overrides = {
      ms: "2.1.3",
      debug: { ".": "4.3.3", ms: "2.1.1" },
      "send@^0.18": { ms: "2.1.1", "ms@npm:^2": "2.1.2" },
      "ms@2.1.2": { ".": "2.1.1" },
      "dbg@npm:debug@^4": { ".": "4.3.1" },
      "@types/node@npm:@types/node@^20": { ".": "20.0.0" },
      "react@catalog:": { ".": "18.0.0" },
    }

    expect(parseOverrides(overrides)).toEqual(overrides)
  })

  test("rejects a shape that Bun does not read", () => {
    expect(() => parseOverrides([])).toThrow(BunLockFormatError)
    expect(() => parseOverrides({ send: { debug: { ms: "2.1.1" } } })).toThrow(
      'bun.lock override "send" must be a string or an object of strings',
    )
    expect(() => parseOverrides({ ms: 1 })).toThrow(
      'bun.lock override "ms" must be a string or an object of strings',
    )
  })

  test("rejects a key that is not a package name with an optional semver range", () => {
    const invalidKeys = [
      { "ms@": { ".": "2.1.1" } },
      { "@types": { ".": "1.0.0" } },
      { "ms@latest": { ".": "2.1.1" } },
      { "ms@github:vercel/ms": { ".": "2.1.1" } },
      { send: { "ms@latest": "2.1.1" } },
      // A parent is matched by its installed version, so a catalog or an alias cannot select it.
      { "send@catalog:": { ms: "2.1.1" } },
      { "send@npm:other@^1": { ms: "2.1.1" } },
    ]
    for (const overrides of invalidKeys) {
      expect(() => parseOverrides(overrides)).toThrow(
        /^bun\.lock override key ".+" is not a package name with an optional semver range$/,
      )
    }
  })
})
