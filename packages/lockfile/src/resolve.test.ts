import { describe, expect, test } from "bun:test"

import { resolveDependencyLockKey } from "./resolve"

describe("resolveDependencyLockKey", () => {
  const packages = {
    kit: [],
    "@scope/app/kit": [],
    "@scope/app/@scope/ui": [],
    "@scope/app/@scope/ui/kit": [],
    "@scope/ui": [],
    "other/kit": [],
  }

  test("prefers the entry nested under the requester, then its ancestors, then the root", () => {
    expect(resolveDependencyLockKey("@scope/app/@scope/ui", "kit", packages)).toBe(
      "@scope/app/@scope/ui/kit",
    )
    expect(resolveDependencyLockKey("@scope/app/@scope/ui/kit", "kit", packages)).toBe(
      "@scope/app/@scope/ui/kit",
    )
    expect(resolveDependencyLockKey("@scope/app/lib", "kit", packages)).toBe("@scope/app/kit")
    expect(resolveDependencyLockKey("@scope/ui", "kit", packages)).toBe("kit")
  })

  test("resolves against a map the same way as against the packages section", () => {
    const map = new Map(Object.entries(packages))

    expect(resolveDependencyLockKey("@scope/app/lib", "kit", map)).toBe("@scope/app/kit")
    expect(resolveDependencyLockKey("@scope/app", "@scope/ui", map)).toBe("@scope/app/@scope/ui")
    expect(resolveDependencyLockKey("@scope/app", "missing", map)).toBeUndefined()
  })

  test("accepts a nested entry without a requester only when it is the unique candidate", () => {
    expect(resolveDependencyLockKey(undefined, "kit", packages)).toBe("kit")
    expect(resolveDependencyLockKey(undefined, "lib", { "app/lib": [] })).toBe("app/lib")
    expect(resolveDependencyLockKey(undefined, "lib", { "app/lib": [], "web/lib": [] })).toBe(
      undefined,
    )
  })
})
