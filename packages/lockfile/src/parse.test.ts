import { describe, expect, test } from "bun:test"

import { parseResolvedSpec } from "./parse"

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
