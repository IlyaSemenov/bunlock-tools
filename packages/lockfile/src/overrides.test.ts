import { describe, expect, test } from "bun:test"

import { dependencyRequirement, effectiveDependencyRange } from "./overrides"
import { BunLockFormatError } from "./parse"

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
    expect(effectiveDependencyRange(lock, undefined, "debug", "^4.3.0")).toBe("4.3.3")
    expect(effectiveDependencyRange(lock, undefined, "debug", "npm:^4.3.0")).toBe("4.3.3")
  })

  test("applies a bare-name override to a range after npm:", () => {
    expect(effectiveDependencyRange(lock, undefined, "debug", "npm:v4.3.0")).toBe("4.3.3")
  })

  test("keeps an npm: alias of a range, as Bun does not override it", () => {
    expect(effectiveDependencyRange(lock, undefined, "dbg", "npm:debug@^4.3.0")).toBe(
      "npm:debug@^4.3.0",
    )
    expect(effectiveDependencyRange(lock, undefined, "debug", "npm:debug@^4.3.0")).toBe(
      "npm:debug@^4.3.0",
    )
    expect(effectiveDependencyRange(lock, undefined, "dbg", "npm:debug")).toBe("npm:debug")
  })

  test("overrides an npm: alias of a dist-tag by the aliased package name", () => {
    expect(effectiveDependencyRange(lock, undefined, "dbg", "npm:debug@latest")).toBe(
      "npm:debug@4.3.3",
    )
    expect(effectiveDependencyRange(lock, undefined, "debug", "npm:debug@latest")).toBe(
      "npm:debug@4.3.3",
    )
    expect(
      effectiveDependencyRange(
        { overrides: { dbg: "4.3.3" } },
        undefined,
        "dbg",
        "npm:debug@latest",
      ),
    ).toBe("npm:debug@latest")
  })

  test("keeps the aliased package for an override written as a range after npm:", () => {
    const rangeAfterNpm = { overrides: { debug: "npm:^4.3.3" } }
    const otherAlias = { overrides: { debug: "npm:other@^1.0.0" } }

    expect(effectiveDependencyRange(rangeAfterNpm, undefined, "dbg", "npm:debug@latest")).toBe(
      "npm:debug@^4.3.3",
    )
    expect(effectiveDependencyRange(otherAlias, undefined, "dbg", "npm:debug@latest")).toBe(
      "npm:other@^1.0.0",
    )
  })
})

describe("scoped overrides", () => {
  const send = { name: "send", version: "0.18.0" }
  const oldSend = { name: "send", version: "0.17.2" }
  const debug = { name: "debug", version: "4.3.4" }

  test("apply a rule scoped to a parent to the direct dependencies of that parent only", () => {
    const lock = { overrides: { send: { debug: "2.6.8", ms: "2.1.1" } } }

    expect(effectiveDependencyRange(lock, send, "ms", "2.1.3")).toBe("2.1.1")
    expect(effectiveDependencyRange(lock, debug, "ms", "2.1.2")).toBe("2.1.2")
    expect(effectiveDependencyRange(lock, undefined, "ms", "2.1.2")).toBe("2.1.2")
  })

  test("match a parent range against the version of the requester", () => {
    const lock = { overrides: { "send@^0.18": { ms: "2.1.1" } } }

    expect(effectiveDependencyRange(lock, send, "ms", "2.1.3")).toBe("2.1.1")
    expect(effectiveDependencyRange(lock, oldSend, "ms", "2.1.3")).toBe("2.1.3")
    expect(effectiveDependencyRange(lock, { name: "send" }, "ms", "2.1.3")).toBe("2.1.3")
  })

  test("match a target range when it overlaps the declared range", () => {
    const lock = { overrides: { "ms@2.1.2": { ".": "2.1.1" } } }

    expect(effectiveDependencyRange(lock, debug, "ms", "2.1.2")).toBe("2.1.1")
    expect(effectiveDependencyRange(lock, debug, "ms", "^2.0.0")).toBe("2.1.1")
    expect(effectiveDependencyRange(lock, debug, "ms", "npm:^2.0.0")).toBe("2.1.1")
    expect(effectiveDependencyRange(lock, debug, "ms", "^2.1.3")).toBe("^2.1.3")
    expect(effectiveDependencyRange(lock, debug, "ms", "latest")).toBe("latest")
  })

  test("read the rule for the group package in a group without a range as an override by name", () => {
    const lock = { overrides: { debug: { ".": "4.3.3", ms: "2.1.1" } } }

    expect(effectiveDependencyRange(lock, send, "debug", "2.6.9")).toBe("4.3.3")
    expect(effectiveDependencyRange(lock, debug, "ms", "2.1.2")).toBe("2.1.1")
  })

  test("prefer a parent range, then a parent, then a matching target range, then an override by name", () => {
    const lock = {
      overrides: {
        ms: "1.0.0",
        "ms@^2": { ".": "2.0.0" },
        send: { ms: "3.0.0", "ms@^2": "3.1.0" },
        "send@^0.18": { ms: "4.0.0", "ms@^2": "4.1.0" },
      },
    }

    expect(effectiveDependencyRange(lock, send, "ms", "^2.1.0")).toBe("4.1.0")
    expect(effectiveDependencyRange(lock, send, "ms", "1.x")).toBe("4.0.0")
    expect(effectiveDependencyRange(lock, oldSend, "ms", "^2.1.0")).toBe("3.1.0")
    expect(effectiveDependencyRange(lock, oldSend, "ms", "1.x")).toBe("3.0.0")
    expect(effectiveDependencyRange(lock, debug, "ms", "^2.1.0")).toBe("2.0.0")
    expect(effectiveDependencyRange(lock, debug, "ms", "1.x")).toBe("1.0.0")
  })

  test("break a tie by the parent range text, then by the target range text", () => {
    const parents = {
      overrides: { "send@^0.18": { ms: "2.0.0" }, "send@>=0.18.0": { ms: "2.1.0" } },
    }
    const targets = { overrides: { "ms@^2.0.0": { ".": "2.0.0" }, "ms@>=2.1.0": { ".": "2.1.0" } } }

    expect(effectiveDependencyRange(parents, send, "ms", "^2.0.0")).toBe("2.1.0")
    expect(effectiveDependencyRange(targets, debug, "ms", "^2.1.0")).toBe("2.1.0")
  })

  test("override an npm: alias only by a target range that names the same package", () => {
    const lock = {
      overrides: {
        app: { dbg: "4.3.1" },
        "dbg@npm:debug@^4": { ".": "4.3.2" },
        "other@npm:other@^4": { ".": "4.3.3" },
      },
    }
    const app = { name: "app" }

    expect(effectiveDependencyRange(lock, app, "dbg", "npm:debug@^4.3.0")).toBe("4.3.2")
    expect(effectiveDependencyRange(lock, app, "dbg", "npm:debug@^5.0.0")).toBe("npm:debug@^5.0.0")
    expect(effectiveDependencyRange(lock, app, "dbg", "^4.3.0")).toBe("4.3.1")
    expect(effectiveDependencyRange(lock, app, "other", "npm:debug@^4.3.0")).toBe(
      "npm:debug@^4.3.0",
    )
  })

  test("read an npm: alias after leading whitespace, as Bun does", () => {
    const lock = { overrides: { app: { dbg: "npm:debug@2.0.0" } } }

    expect(effectiveDependencyRange(lock, { name: "app" }, "dbg", " npm:debug@^1.0.0")).toBe(
      " npm:debug@^1.0.0",
    )
  })

  test("override an npm: alias of a dist-tag by rules without a target range for the aliased package", () => {
    const lock = { overrides: { app: { debug: "4.3.3" }, "debug@^4": { ".": "4.3.1" } } }

    expect(effectiveDependencyRange(lock, { name: "app" }, "dbg", "npm:debug@latest")).toBe(
      "npm:debug@4.3.3",
    )
    expect(effectiveDependencyRange(lock, { name: "web" }, "dbg", "npm:debug@latest")).toBe(
      "npm:debug@latest",
    )
  })

  test("stop when the tools cannot tell whether a winning rule applies", () => {
    const lock = {
      overrides: { leaf: "2.0.0", "leaf@^1": { ".": "1.2.3" }, app: { leaf: "3.0.0" } },
    }

    expect(() => effectiveDependencyRange(lock, debug, "leaf", "01.2.3")).toThrow(
      new BunLockFormatError(
        'Cannot tell whether bun.lock override "leaf@^1" applies to leaf declared as "01.2.3"',
      ),
    )
    expect(effectiveDependencyRange(lock, { name: "app" }, "leaf", "01.2.3")).toBe("3.0.0")
    expect(effectiveDependencyRange(lock, debug, "leaf", "latest")).toBe("2.0.0")
    expect(effectiveDependencyRange(lock, debug, "leaf", " ^1.0.0")).toBe("1.2.3")
  })

  test("stop when the tools cannot tell whether a parent range matches the requester version", () => {
    const lock = { overrides: { "app@>=0.0.0 <=0.0.0-beta": { debug: "4.3.3" } } }
    const app = { name: "app", version: "0.0.0-alpha" }

    expect(() => effectiveDependencyRange(lock, app, "dbg", "npm:debug@latest")).toThrow(
      'Cannot tell whether bun.lock override "app@>=0.0.0 <=0.0.0-beta" > "debug" applies to debug declared as "npm:debug@latest"',
    )
  })

  test("stop when the tools cannot tell whether an npm: alias of an unparsed range is overridden", () => {
    const lock = { overrides: { debug: "2.0.0", "dbg@npm:debug@^1": { ".": "npm:debug@1.2.3" } } }

    expect(() => effectiveDependencyRange(lock, undefined, "dbg", "npm:debug@01.2.3")).toThrow(
      'Cannot tell whether bun.lock override "dbg@npm:debug@^1" applies to dbg declared as "npm:debug@01.2.3"',
    )
  })

  test("match a catalog target range against a reference to the same catalog", () => {
    const lock = { overrides: { "react@catalog:": { ".": "18.0.0" } } }

    expect(effectiveDependencyRange(lock, undefined, "react", "catalog:default")).toBe("18.0.0")
    expect(effectiveDependencyRange(lock, undefined, "react", "catalog:")).toBe("18.0.0")
    expect(effectiveDependencyRange(lock, undefined, "react", "catalog:legacy")).toBe(
      "catalog:legacy",
    )
    expect(effectiveDependencyRange(lock, undefined, "react", "^18.0.0")).toBe("^18.0.0")
  })
})
