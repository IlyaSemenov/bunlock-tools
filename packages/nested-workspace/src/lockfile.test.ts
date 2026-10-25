import { describe, expect, test } from "bun:test"

import type { Lockfile } from "./lockfile"
import {
  applyManifestToLockfile,
  mergeLockfiles,
  parseLockfile,
  relocateLockfile,
  resolveDependency,
  satisfiesSpecifier,
} from "./lockfile"

describe("parseLockfile", () => {
  test("parses JSONC with trailing commas", () => {
    const lock = parseLockfile(`{ "lockfileVersion": 1, "workspaces": {}, "packages": {}, }`)

    expect(lock.lockfileVersion).toBe(1)
  })

  test("names the file in syntax errors", () => {
    expect(() => parseLockfile(`{ "lockfileVersion": `, "acme/bun.lock")).toThrow(
      /^acme\/bun\.lock: /,
    )
  })

  test("rejects an unknown lockfileVersion", () => {
    expect(() => parseLockfile(`{ "lockfileVersion": 3 }`, "acme/bun.lock")).toThrow(
      "acme/bun.lock has lockfileVersion 3, supported versions: 1, 2",
    )
  })

  test("rejects scoped overrides before the lockfileVersion", () => {
    for (const lockfileVersion of [1, 2, 3]) {
      const text = JSON.stringify({ lockfileVersion, overrides: { send: { ms: "2.1.1" } } })

      expect(() => parseLockfile(text, "acme/bun.lock")).toThrow(
        'acme/bun.lock: bun.lock override "send" is scoped to a parent package or a version selector; only overrides by package name are supported',
      )
    }
  })
})

describe("relocateLockfile", () => {
  test("moves workspaces, including the root, and local resolutions into the nested directory", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "": { name: "@nested/root", devDependencies: { eslint: "^9.0.0" } },
        "packages/core": { name: "@nested/core" },
      },
      packages: {
        "@nested/core": ["@nested/core@workspace:packages/core"],
        "@nested/root": ["@nested/root@workspace:"],
        eslint: ["eslint@9.0.0", "", {}, "sha-eslint"],
        "@nested/core/vendored": ["vendored@file:vendor/vendored", {}],
        linked: ["linked@link:./vendor/linked", {}],
        absolute: ["absolute@file:/opt/absolute", {}],
      },
    }

    const relocated = relocateLockfile(lock, "nested")

    expect(Object.keys(relocated.workspaces)).toEqual(["nested", "nested/packages/core"])
    expect(Object.values(relocated.packages).map(([resolution]) => resolution)).toEqual([
      "@nested/core@workspace:nested/packages/core",
      "@nested/root@workspace:nested",
      "eslint@9.0.0",
      "vendored@file:nested/vendor/vendored",
      "linked@link:./nested/vendor/linked",
      "absolute@file:/opt/absolute",
    ])
  })

  test("names the root workspace after the nested root package.json", () => {
    const relocate = (name?: string) =>
      relocateLockfile(
        {
          lockfileVersion: 1,
          workspaces: { "": { name, devDependencies: { eslint: "^9.0.0" } } },
          packages: {},
        },
        "nested",
        "@nested/root",
      ).workspaces
    const expected = { nested: { name: "@nested/root", devDependencies: { eslint: "^9.0.0" } } }

    expect(relocate()).toEqual(expected)
    expect(relocate("@nested/renamed")).toEqual(expected)
  })
})

describe("applyManifestToLockfile", () => {
  test("records the root fields that affect resolution", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {},
      packages: {},
      overrides: { stale: "1.0.0" },
    }

    const applied = applyManifestToLockfile(lock, {
      workspaces: { packages: ["nested/*"], catalog: { zod: "^4.0.0" } },
      patchedDependencies: { "exceljs@4.4.0": "nested/patches/exceljs@4.4.0.patch" },
      trustedDependencies: ["esbuild"],
    })

    expect(applied).toEqual({
      lockfileVersion: 1,
      workspaces: {},
      packages: {},
      catalog: { zod: "^4.0.0" },
      patchedDependencies: { "exceljs@4.4.0": "nested/patches/exceljs@4.4.0.patch" },
    })
  })

  describe("`$name` overrides", () => {
    const lock: Lockfile = { lockfileVersion: 1, workspaces: {}, packages: {} }

    test("records the range that the root declares", () => {
      const applied = applyManifestToLockfile(lock, {
        dependencies: { ms: "~2.1.1" },
        optionalDependencies: { ms: "~2.1.1", constructor: "^1.0.0" },
        overrides: { ms: "$ms", constructor: "$constructor", debug: "4.3.3" },
      })

      expect(applied.overrides).toEqual({ ms: "~2.1.1", constructor: "^1.0.0", debug: "4.3.3" })
    })

    test("rejects a reference that does not resolve to one range of the same package", () => {
      expect(() => applyManifestToLockfile(lock, { overrides: { ms: "$ms" } })).toThrow(
        'package.json override "ms": "$ms" refers to a dependency that the root does not declare',
      )
      expect(() =>
        applyManifestToLockfile(lock, {
          dependencies: {},
          overrides: { constructor: "$constructor" },
        }),
      ).toThrow("refers to a dependency that the root does not declare")
      expect(() =>
        applyManifestToLockfile(lock, {
          dependencies: { ms: "~2.1.1" },
          peerDependencies: { ms: "^2.0.0" },
          overrides: { ms: "$ms" },
        }),
      ).toThrow("refers to different ranges in the dependency groups")
      expect(() =>
        applyManifestToLockfile(lock, {
          dependencies: { debug: "^4.0.0" },
          overrides: { ms: "$debug" },
        }),
      ).toThrow("refers to another package")
    })
  })
})

describe("mergeLockfiles", () => {
  test("keeps a host package the resolution that the nested root entry does not satisfy", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "apps/web": { name: "@test/host", dependencies: { multi: "^1.0.0" } } },
      packages: {
        kit: ["kit@4.6.1", "", {}, "sha-kit-4"],
        multi: ["multi@1.0.0", "", { dependencies: { kit: "~4.6.1" } }, "sha-multi"],
        sentry: ["sentry@1.0.0", "", { dependencies: { kit: "^3.0.0" } }, "sha-sentry"],
        "sentry/kit": ["kit@3.20.0", "", {}, "sha-kit-3-old"],
      },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "nested/apps/web": { name: "@test/nested", dependencies: { sentry: "^1.0.0" } },
      },
      packages: {
        kit: ["kit@3.21.11", "", {}, "sha-kit-3"],
        sentry: ["sentry@1.0.0", "", { dependencies: { kit: "^3.0.0" } }, "sha-sentry"],
      },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages.kit?.[0]).toBe("kit@3.21.11")
    expect(packages["multi/kit"]?.[0]).toBe("kit@4.6.1")
    expect(packages).not.toHaveProperty(["sentry/kit"])
  })

  test("repairs a host dependency that the previous host resolution does not satisfy", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "apps/web": { name: "@test/host", dependencies: { multi: "^1.0.0" } } },
      packages: {
        ignore: ["ignore@5.3.2", "", {}, "sha-ignore-5"],
        kit: ["kit@4.6.1", "", { dependencies: { ignore: "^7.0.12" } }, "sha-kit-4"],
        multi: ["multi@1.0.0", "", { dependencies: { kit: "~4.6.1" } }, "sha-multi"],
      },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "nested/apps/web": { name: "@test/nested", dependencies: { kit: "^3.0.0" } } },
      packages: {
        ignore: ["ignore@5.3.2", "", {}, "sha-ignore-5"],
        kit: ["kit@3.21.11", "", { dependencies: { ignore: "^7.0.6" } }, "sha-kit-3"],
        "kit/ignore": ["ignore@7.0.12", "", {}, "sha-ignore-7"],
      },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages["multi/kit"]?.[0]).toBe("kit@4.6.1")
    expect(packages["multi/kit/ignore"]?.[0]).toBe("ignore@7.0.12")
  })

  test("keeps a host workspace the resolution of a dependency with an unsatisfied direct range", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "apps/web": {
          name: "@test/host",
          dependencies: { kit: "catalog:", alias: "npm:kit@^4.0.0" },
        },
      },
      packages: {
        kit: ["kit@4.6.1", "", {}, "sha-kit-4"],
        alias: ["kit@4.6.1", "", {}, "sha-kit-4"],
      },
      catalog: { kit: "^4.0.0" },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "nested/apps/web": { name: "@test/nested", dependencies: { kit: "^3.0.0" } } },
      packages: {
        kit: ["kit@3.21.11", "", {}, "sha-kit-3"],
        alias: ["kit@3.21.11", "", {}, "sha-kit-3"],
      },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages["@test/host/kit"]?.[0]).toBe("kit@4.6.1")
    expect(packages["@test/host/alias"]?.[0]).toBe("kit@4.6.1")
  })

  test("checks dependencies against overrides", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "apps/web": { name: "@test/host", dependencies: { lib: "^1.0.0" } } },
      packages: {
        lib: ["lib@1.0.0", "", { dependencies: { kit: "^3.0.0" } }, "sha-lib"],
        kit: ["kit@4.6.1", "", {}, "sha-kit-4"],
        "other/kit": ["kit@3.21.11", "", {}, "sha-kit-3"],
      },
      overrides: { kit: "4.6.1" },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "nested/apps/web": { name: "@test/nested", dependencies: { kit: "^4.0.0" } } },
      packages: { kit: ["kit@4.6.1", "", {}, "sha-kit-4"] },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages).not.toHaveProperty(["lib/kit"])
  })

  test("reads a versionless npm alias that is also a valid range as a package name", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "apps/web": { name: "@test/host", dependencies: { dep: "npm:1" } } },
      packages: { dep: ["1@3.0.0", "", {}, "sha-1"] },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "nested/apps/web": { name: "@test/nested", dependencies: { dep: "^1.0.0" } } },
      packages: { dep: ["dep@1.0.0", "", {}, "sha-dep"] },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages["@test/host/dep"]?.[0]).toBe("1@3.0.0")
  })

  test("keeps an npm alias resolved to the package it names", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "apps/web": { name: "@test/host", dependencies: { alias: "npm:foo@^1.0.0" } } },
      packages: { alias: ["foo@1.0.0", "", {}, "sha-foo"] },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "nested/apps/web": { name: "@test/nested", dependencies: { alias: "npm:bar@^1.0.0" } },
      },
      packages: { alias: ["bar@1.0.0", "", {}, "sha-bar"] },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages.alias?.[0]).toBe("bar@1.0.0")
    expect(packages["@test/host/alias"]?.[0]).toBe("foo@1.0.0")
  })

  test("takes the chains under the nested root from the nested lockfile only", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "": { name: "@test/root", devDependencies: { kit: "1.0.0" } },
        nested: { name: "@nested/root", devDependencies: { kit: "^2.0.0" } },
      },
      packages: {
        kit: ["kit@1.0.0", "", {}, "sha-kit-1"],
        "@nested/root/kit": ["kit@2.0.0", "", {}, "sha-kit-2"],
      },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { nested: { name: "@nested/root", devDependencies: { kit: "^2.0.0" } } },
      packages: { kit: ["kit@2.1.0", "", {}, "sha-kit-2-1"] },
    }

    const merged = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(merged.packages).toEqual({
      kit: ["kit@1.0.0", "", {}, "sha-kit-1"],
      "@nested/root/kit": ["kit@2.1.0", "", {}, "sha-kit-2-1"],
    })
  })

  test("keeps a host root dependency at the top level and nests the nested entry under its nested users", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "": { name: "@test/root", devDependencies: { kit: "^1.7.0" } },
        "apps/web": { name: "@test/web", dependencies: { pino: "^9.0.0" } },
      },
      packages: {
        kit: ["kit@1.8.5", "", { dependencies: { ms: "^3.0.0" } }, "sha-kit-1-8"],
        "kit/ms": ["ms@3.0.0", "", {}, "sha-ms-3"],
        pino: ["pino@9.1.0", "", { dependencies: { kit: "^1.0.0" } }, "sha-pino"],
      },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        nested: { name: "@nested/root", devDependencies: { kit: "^1.6.0" } },
        "nested/packages/core": { name: "@nested/core", dependencies: { sentry: "^1.0.0" } },
      },
      packages: {
        kit: ["kit@1.6.0", "", { dependencies: { ms: "^2.0.0" } }, "sha-kit-1-6"],
        "kit/ms": ["ms@2.1.3", "", {}, "sha-ms-2"],
        ms: ["ms@1.0.0", "", {}, "sha-ms-1"],
        sentry: ["sentry@1.0.0", "", { dependencies: { kit: "^1.0.0" } }, "sha-sentry"],
      },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(
      Object.fromEntries(Object.entries(packages).map(([key, [resolution]]) => [key, resolution])),
    ).toEqual({
      pino: "pino@9.1.0",
      kit: "kit@1.8.5",
      "kit/ms": "ms@3.0.0",
      ms: "ms@1.0.0",
      sentry: "sentry@1.0.0",
      "@nested/root/kit": "kit@1.6.0",
      "@nested/root/kit/ms": "ms@2.1.3",
      "sentry/kit": "kit@1.6.0",
      "sentry/kit/ms": "ms@2.1.3",
    })
  })

  test("keeps the nested resolutions of an entry that moves under a dependent with its own versions", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "": { name: "@test/root", devDependencies: { kit: "^1.7.0" } } },
      packages: { kit: ["kit@1.8.5", "", {}, "sha-kit-1-8"] },
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "nested/packages/core": { name: "@nested/core", dependencies: { sentry: "^1.0.0" } },
      },
      packages: {
        kit: ["kit@1.6.0", "", { dependencies: { ms: "^1.0.0" } }, "sha-kit-1-6"],
        ms: ["ms@1.1.0", "", {}, "sha-ms-1-1"],
        sentry: [
          "sentry@1.0.0",
          "",
          { dependencies: { kit: "^1.0.0", ms: "1.2.0" } },
          "sha-sentry",
        ],
        "sentry/ms": ["ms@1.2.0", "", {}, "sha-ms-1-2"],
      },
    }

    const { packages } = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(packages["sentry/kit"]?.[0]).toBe("kit@1.6.0")
    expect(packages["sentry/kit/ms"]?.[0]).toBe("ms@1.1.0")
  })

  test("keeps the nested tree of a moved entry when its dependent has the same version with other dependencies or integrity", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: { "": { name: "@test/root", devDependencies: { kit: "^1.7.0" } } },
      packages: { kit: ["kit@1.8.5", "", {}, "sha-kit-1-8"] },
    }
    const merge = (sentryMs: Lockfile["packages"]) =>
      mergeLockfiles(
        hostLock,
        {
          lockfileVersion: 1,
          workspaces: {
            "nested/packages/core": { name: "@nested/core", dependencies: { sentry: "^1.0.0" } },
          },
          packages: {
            kit: ["kit@1.6.0", "", { dependencies: { ms: "^1.0.0" } }, "sha-kit-1-6"],
            ms: ["ms@1.0.0", "", { dependencies: { leaf: "^1.0.0" } }, "sha-ms-1"],
            leaf: ["leaf@1.0.0", "", {}, "sha-leaf-1-0"],
            sentry: [
              "sentry@1.0.0",
              "",
              { dependencies: { kit: "^1.0.0", ms: "1.0.0" } },
              "sha-sentry",
            ],
            ...sentryMs,
          },
        },
        "nested",
      ).packages

    const withOtherLeaf = merge({
      "sentry/ms": ["ms@1.0.0", "", { dependencies: { leaf: "^1.0.0" } }, "sha-ms-1"],
      "sentry/ms/leaf": ["leaf@1.1.0", "", {}, "sha-leaf-1-1"],
    })
    const withOtherIntegrity = merge({
      "sentry/ms": ["ms@1.0.0", "", { dependencies: { leaf: "^1.0.0" } }, "sha-ms-1-repacked"],
    })

    expect(withOtherLeaf["sentry/kit/ms"]).toEqual(withOtherLeaf.ms)
    expect(withOtherIntegrity["sentry/kit/ms"]).toEqual(withOtherIntegrity.ms)
  })

  test("finds a fallback host root resolution in nested chains regardless of the dependency order", () => {
    const merge = (devDependencies: Record<string, string>) =>
      mergeLockfiles(
        {
          lockfileVersion: 1,
          workspaces: { "": { name: "@test/root", devDependencies } },
          packages: {
            kit: ["kit@2.0.0", "", {}, "sha-kit-2"],
            ms: ["ms@1.0.0", "", {}, "sha-ms-1"],
          },
        },
        {
          lockfileVersion: 1,
          workspaces: { nested: { name: "@nested/root", devDependencies: { kit: "^1.0.0" } } },
          packages: {
            kit: ["kit@1.0.0", "", { dependencies: { ms: "^2.0.0" } }, "sha-kit-1"],
            "kit/ms": ["ms@2.0.0", "", {}, "sha-ms-2"],
            ms: ["ms@1.0.0", "", {}, "sha-ms-1"],
          },
        },
        "nested",
      ).packages

    expect(merge({ kit: "^2.0.0", ms: "^2.0.0" }).ms?.[0]).toBe("ms@2.0.0")
    expect(merge({ ms: "^2.0.0", kit: "^2.0.0" }).ms?.[0]).toBe("ms@2.0.0")
  })

  test("moves the nested entries of several host root dependencies regardless of their order", () => {
    const merge = (devDependencies: Record<string, string>) =>
      mergeLockfiles(
        {
          lockfileVersion: 1,
          workspaces: { "": { name: "@test/root", devDependencies } },
          packages: {
            kit: ["kit@2.0.0", "", {}, "sha-kit-2"],
            ms: ["ms@2.0.0", "", {}, "sha-ms-2"],
          },
        },
        {
          lockfileVersion: 1,
          workspaces: {
            nested: { name: "@nested/root", devDependencies: { kit: "^1.0.0", ms: "^1.0.0" } },
          },
          packages: {
            kit: ["kit@1.0.0", "", { dependencies: { ms: "^1.0.0" } }, "sha-kit-1"],
            ms: ["ms@1.0.0", "", {}, "sha-ms-1"],
          },
        },
        "nested",
      ).packages
    const resolutions = (packages: Lockfile["packages"]) =>
      Object.fromEntries(Object.entries(packages).map(([key, [resolution]]) => [key, resolution]))

    const expected = {
      "@nested/root/kit": "kit@1.0.0",
      "@nested/root/ms": "ms@1.0.0",
      kit: "kit@2.0.0",
      ms: "ms@2.0.0",
    }
    expect(resolutions(merge({ kit: "^2.0.0", ms: "^2.0.0" }))).toEqual(expected)
    expect(resolutions(merge({ ms: "^2.0.0", kit: "^2.0.0" }))).toEqual(expected)
  })

  test("takes nested workspaces from the nested lockfile only", () => {
    const hostLock: Lockfile = {
      lockfileVersion: 1,
      workspaces: {
        "": { name: "@test/root" },
        nested: { name: "@nested/root", devDependencies: { kit: "^4.0.0" } },
        "nested/packages/removed": { name: "@nested/removed", dependencies: { kit: "^4.0.0" } },
        "nested/packages/core": { name: "@nested/core" },
      },
      packages: {},
    }
    const nestedLock: Lockfile = {
      lockfileVersion: 2,
      workspaces: {
        nested: { name: "@nested/root" },
        "nested/packages/core": { name: "@nested/core", dependencies: { kit: "^3.0.0" } },
      },
      packages: { kit: ["kit@3.21.11", "", {}, "sha-kit-3"] },
    }

    const merged = mergeLockfiles(hostLock, nestedLock, "nested")

    expect(merged.lockfileVersion).toBe(2)
    expect(merged.workspaces).toEqual({
      "": { name: "@test/root" },
      nested: { name: "@nested/root" },
      "nested/packages/core": { name: "@nested/core", dependencies: { kit: "^3.0.0" } },
    })
    expect(merged.packages).toEqual({ kit: ["kit@3.21.11", "", {}, "sha-kit-3"] })
  })
})

describe("satisfiesSpecifier", () => {
  const lock: Lockfile = { lockfileVersion: 1, workspaces: {}, packages: {} }

  test("reads a version after npm: as a range of the dependency itself", () => {
    expect(satisfiesSpecifier(lock, "dep", "npm:v1.0.0", ["dep@1.0.0", "", {}, "sha-dep"])).toBe(
      true,
    )
    expect(satisfiesSpecifier(lock, "dep", "npm:1", ["dep@1.0.0", "", {}, "sha-dep"])).toBe(false)
  })

  test("checks an npm alias of a dist-tag against an override of the aliased package", () => {
    const overridden: Lockfile = { ...lock, overrides: { kit: "npm:^3.0.0" } }

    expect(
      satisfiesSpecifier(overridden, "alias", "npm:kit@latest", ["kit@3.21.11", "", {}, "sha"]),
    ).toBe(true)
    expect(
      satisfiesSpecifier(overridden, "alias", "npm:kit@latest", ["kit@4.6.1", "", {}, "sha"]),
    ).toBe(false)
  })
})

describe("resolveDependency", () => {
  const lock: Lockfile = {
    lockfileVersion: 1,
    workspaces: {},
    packages: {
      kit: ["kit@3.21.11", "", {}, "sha-kit-3"],
      "@test/host/kit": ["kit@4.6.1", "", {}, "sha-kit-4"],
    },
  }

  test("prefers the entry nested under the workspace", () => {
    expect(resolveDependency(lock, "@test/host", "kit")).toBe("kit@4.6.1")
    expect(resolveDependency(lock, "@test/other", "kit")).toBe("kit@3.21.11")
    expect(resolveDependency(lock, "@test/other", "missing")).toBeUndefined()
  })
})
