import { describe, expect, test } from "bun:test"

import {
  findDirectDependencyMismatches,
  findOwnDependencyChanges,
  findTransitiveMismatches,
  findUncoveredWorkspaces,
  findWorkspaceMismatches,
} from "./check"
import type { Lockfile } from "./lockfile"

const nestedLock: Lockfile = {
  lockfileVersion: 1,
  workspaces: {
    "nested/apps/web": {
      name: "@nested/web",
      dependencies: { "@nested/core": "workspace:*", sentry: "^1.0.0" },
    },
    "nested/packages/core": { name: "@nested/core", dependencies: { zod: "^4.0.0" } },
  },
  packages: {
    "@nested/core": ["@nested/core@workspace:nested/packages/core"],
    "@nested/web": ["@nested/web@workspace:nested/apps/web"],
    eslint: ["eslint@9.0.0", "", {}, "sha-eslint"],
    kit: ["kit@3.21.11", "", {}, "sha-kit-3"],
    sentry: ["sentry@1.0.0", "", { dependencies: { kit: "^3.0.0" } }, "sha-sentry"],
    zod: ["zod@4.1.0", "", {}, "sha-zod"],
  },
}

describe("findUncoveredWorkspaces", () => {
  test("matches nested workspaces against host patterns", () => {
    expect(
      findUncoveredWorkspaces({ workspaces: ["./nested/apps/*", "apps/*"] }, nestedLock),
    ).toEqual(["nested/packages/core"])
    expect(
      findUncoveredWorkspaces(
        { workspaces: { packages: ["nested/*/*", "!nested/apps/web"] } },
        nestedLock,
      ),
    ).toEqual(["nested/apps/web"])
  })
})

describe("findWorkspaceMismatches", () => {
  test("reports changed, missing, and removed nested workspaces", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "": { name: "@host/root" },
        "nested/apps/web": {
          dependencies: { sentry: "^1.0.0", "@nested/core": "workspace:*" },
          name: "@nested/web",
        },
        "nested/packages/removed": { name: "@nested/removed" },
      },
      packages: {},
    }

    expect(findWorkspaceMismatches(lock, nestedLock, "nested")).toEqual([
      "nested/packages/core",
      "nested/packages/removed",
    ])
  })
})

describe("dependency mismatches", () => {
  const lock: Lockfile = {
    ...nestedLock,
    packages: {
      ...nestedLock.packages,
      kit: ["kit@3.22.0", "", {}, "sha-kit-3-new"],
      "@nested/core/zod": ["zod@4.2.0", "", {}, "sha-zod-new"],
    },
  }

  test("findDirectDependencyMismatches reports direct dependencies resolved differently", () => {
    expect(findDirectDependencyMismatches(lock, nestedLock)).toEqual([
      { workspace: "@nested/core", dependency: "zod", expected: "zod@4.1.0", actual: "zod@4.2.0" },
    ])
  })

  test("findDirectDependencyMismatches reports a different integrity of the same version", () => {
    const repacked: Lockfile = {
      ...nestedLock,
      packages: { ...nestedLock.packages, sentry: ["sentry@1.0.0", "", {}, "sha-sentry-other"] },
    }

    expect(findDirectDependencyMismatches(repacked, nestedLock)).toEqual([
      {
        workspace: "@nested/web",
        dependency: "sentry",
        expected: "sentry@1.0.0",
        actual: "sentry@1.0.0",
      },
    ])
  })

  test("findTransitiveMismatches reports reachable dependencies resolved differently", () => {
    expect(findTransitiveMismatches(lock, nestedLock)).toEqual([
      { path: ["@nested/web", "sentry", "kit"], expected: "kit@3.21.11", actual: "kit@3.22.0" },
    ])
  })

  test("findTransitiveMismatches ignores a different hoisting layout of the same versions", () => {
    const hoisted: Lockfile = {
      ...nestedLock,
      packages: {
        ...nestedLock.packages,
        kit: ["kit@4.6.1", "", {}, "sha-kit-4"],
        "sentry/kit": ["kit@3.21.11", "", {}, "sha-kit-3"],
      },
    }

    expect(findTransitiveMismatches(hoisted, nestedLock)).toEqual([])
  })

  test("findTransitiveMismatches skips edges that the nested lockfile resolves outside their range", () => {
    const broken: Lockfile = {
      ...nestedLock,
      packages: { ...nestedLock.packages, kit: ["kit@2.0.0", "", {}, "sha-kit-2"] },
    }

    expect(findTransitiveMismatches(nestedLock, broken)).toEqual([])
  })

  test("findTransitiveMismatches checks edges against the overrides of the nested lockfile", () => {
    const overridden: Lockfile = {
      ...nestedLock,
      packages: { ...nestedLock.packages, kit: ["kit@4.6.1", "", {}, "sha-kit-4"] },
      overrides: { kit: "4.6.1" },
    }
    const host: Lockfile = {
      ...overridden,
      packages: { ...overridden.packages, kit: ["kit@4.7.0", "", {}, "sha-kit-4-new"] },
    }

    expect(findTransitiveMismatches(host, overridden)).toEqual([
      { path: ["@nested/web", "sentry", "kit"], expected: "kit@4.6.1", actual: "kit@4.7.0" },
    ])
  })

  test("findTransitiveMismatches ignores lockfile metadata", () => {
    const withMetadata: Lockfile = {
      ...nestedLock,
      packages: {
        ...nestedLock.packages,
        kit: ["kit@3.21.11", "", { bin: { kit: "cli.js" } }, "sha-kit-3"],
      },
    }

    expect(findTransitiveMismatches(withMetadata, nestedLock)).toEqual([])
  })
})

describe("findOwnDependencyChanges", () => {
  test("reports changed external dependencies of host workspaces unless they took the nested version", () => {
    const before: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "apps/api": {
          name: "@host/api",
          dependencies: {
            "@nested/core": "workspace:*",
            kit: "^3.0.0",
            pino: "^9.0.0",
            zod: "^4.0.0",
          },
        },
        "nested/packages/core": { name: "@nested/core", dependencies: { left: "^1.0.0" } },
      },
      packages: {
        kit: ["kit@3.20.0", "", {}, "sha-kit-3-old"],
        pino: ["pino@9.1.0", "", {}, "sha-pino"],
        zod: ["zod@4.0.0", "", {}, "sha-zod-old"],
      },
    }
    const after: Lockfile = {
      ...before,
      packages: {
        kit: ["kit@3.21.11", "", {}, "sha-kit-3"],
        pino: ["pino@9.2.0", "", {}, "sha-pino-new"],
        zod: ["zod@4.1.0", "", {}, "sha-zod"],
        "@host/api/zod": ["zod@4.0.5", "", {}, "sha-zod-host"],
      },
    }

    expect(findOwnDependencyChanges(before, after, nestedLock, "nested")).toEqual([
      { workspace: "@host/api", dependency: "pino", expected: "pino@9.1.0", actual: "pino@9.2.0" },
      { workspace: "@host/api", dependency: "zod", expected: "zod@4.0.0", actual: "zod@4.0.5" },
    ])
  })

  test("reports a dependency that took a nested version outside the host range or disappeared", () => {
    const before: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "": { dependencies: { pino: "^9.0.0", zod: "^3.0.0" } } },
      packages: {
        pino: ["pino@9.1.0", "", {}, "sha-pino"],
        zod: ["zod@3.25.0", "", {}, "sha-zod-3"],
      },
    }
    const after: Lockfile = { ...before, packages: { zod: ["zod@4.1.0", "", {}, "sha-zod"] } }

    expect(findOwnDependencyChanges(before, after, nestedLock, "nested")).toEqual([
      { workspace: "", dependency: "pino", expected: "pino@9.1.0", actual: undefined },
      { workspace: "", dependency: "zod", expected: "zod@3.25.0", actual: "zod@4.1.0" },
    ])
  })
})
