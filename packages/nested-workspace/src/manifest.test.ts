import { describe, expect, test } from "bun:test"

import type { PackageManifest } from "./manifest"
import { diffManifests, getCatalogs, readConfig, syncManifest } from "./manifest"

describe("readConfig", () => {
  test("normalizes the directory and defaults to all fields", () => {
    expect(readConfig({ "bun-nested-workspace": { dir: "./nested/" } })).toEqual({
      dir: "nested",
      fields: ["catalog", "catalogs", "overrides", "patchedDependencies", "trustedDependencies"],
      synced: {},
    })
  })

  test("rejects a missing config, a directory outside the host, and unknown fields", () => {
    expect(() => readConfig({})).toThrow('package.json has no "bun-nested-workspace" field')
    for (const dir of ["../nested", "/", "///", "/nested"]) {
      expect(() => readConfig({ "bun-nested-workspace": { dir } })).toThrow(
        "must be a directory inside the host root",
      )
    }
    expect(() =>
      readConfig({
        "bun-nested-workspace": { dir: "nested", fields: ["resolutions" as "catalog"] },
      }),
    ).toThrow('"bun-nested-workspace.fields" must be an array of')
  })
})

describe("getCatalogs", () => {
  test("reads catalogs from workspaces or from the top level", () => {
    expect(getCatalogs({ workspaces: { catalog: { zod: "^4.0.0" } } })).toEqual({
      catalog: { zod: "^4.0.0" },
      catalogs: undefined,
    })
    expect(getCatalogs({ catalogs: { test: { vitest: "^5.0.0" } } })).toEqual({
      catalog: undefined,
      catalogs: { test: { vitest: "^5.0.0" } },
    })
  })

  test("rejects a field defined in both places", () => {
    expect(() =>
      getCatalogs({ catalog: { zod: "^4.0.0" }, workspaces: { catalog: { zod: "^4.0.0" } } }),
    ).toThrow('package.json defines both "catalog" and "workspaces.catalog"')
  })
})

describe("syncManifest", () => {
  const config = (extra: object = {}) => ({ "bun-nested-workspace": { dir: "nested", ...extra } })

  test("syncs the catalog into the object form of workspaces", () => {
    const host: PackageManifest = { workspaces: ["apps/*", "nested/packages/*"], ...config() }
    const nested: PackageManifest = {
      workspaces: { packages: ["packages/*"], catalog: { zod: "^4.0.0", h3: "^1.15.0" } },
    }

    const { manifest, overridden } = syncManifest(host, nested)

    expect(manifest.workspaces).toEqual({
      packages: ["apps/*", "nested/packages/*"],
      catalog: { h3: "^1.15.0", zod: "^4.0.0" },
    })
    expect(manifest["bun-nested-workspace"]).toEqual({
      dir: "nested",
      synced: { catalog: ["h3", "zod"] },
    })
    expect(overridden).toEqual([])
  })

  test("syncs the catalog to the top level when the host keeps it there", () => {
    const host: PackageManifest = {
      workspaces: ["nested/packages/*"],
      catalog: { "es-toolkit": "^1.0.0" },
      ...config(),
    }
    const nested: PackageManifest = { catalog: { zod: "^4.0.0" } }

    const { manifest } = syncManifest(host, nested)

    expect(manifest.workspaces).toEqual(["nested/packages/*"])
    expect(manifest.catalog).toEqual({ "es-toolkit": "^1.0.0", zod: "^4.0.0" })
  })

  test("syncs named catalogs", () => {
    const host: PackageManifest = {
      workspaces: { packages: ["nested/packages/*"], catalogs: { test: { jest: "^30.0.0" } } },
      ...config(),
    }
    const nested: PackageManifest = {
      workspaces: { catalogs: { test: { vitest: "^5.0.0" }, ui: { vue: "^3.5.0" } } },
    }

    const { manifest } = syncManifest(host, nested)

    expect(manifest.workspaces).toEqual({
      packages: ["nested/packages/*"],
      catalogs: { test: { jest: "^30.0.0", vitest: "^5.0.0" }, ui: { vue: "^3.5.0" } },
    })
    expect(manifest["bun-nested-workspace"]?.synced).toEqual({
      catalogs: { test: ["vitest"], ui: ["vue"] },
    })
  })

  test("keeps each catalog field where the host defines it", () => {
    const host: PackageManifest = {
      workspaces: { packages: ["nested/*"], catalogs: { test: { jest: "^30.0.0" } } },
      catalog: { "es-toolkit": "^1.0.0" },
      ...config(),
    }
    const nested: PackageManifest = {
      workspaces: { catalog: { zod: "^4.0.0" }, catalogs: { ui: { vue: "^3.5.0" } } },
    }

    const first = syncManifest(host, nested)
    const second = syncManifest(first.manifest, nested)

    expect(first.manifest.catalog).toEqual({ "es-toolkit": "^1.0.0", zod: "^4.0.0" })
    expect(first.manifest.workspaces).toEqual({
      packages: ["nested/*"],
      catalogs: { test: { jest: "^30.0.0" }, ui: { vue: "^3.5.0" } },
    })
    expect(second.manifest).toEqual(first.manifest)
  })

  test("syncs overrides", () => {
    const host: PackageManifest = { overrides: { semver: "^7.0.0" }, ...config() }
    const nested: PackageManifest = { overrides: { "string-width": "^4.2.3" } }

    expect(syncManifest(host, nested).manifest.overrides).toEqual({
      semver: "^7.0.0",
      "string-width": "^4.2.3",
    })
  })

  test("syncs overrides scoped to a parent package or a version range by their top-level key", () => {
    const host: PackageManifest = {
      overrides: { micromatch: { picomatch: "^2.3.1" }, "debug@^2": "2.6.9" },
      ...config(),
    }
    const nested: PackageManifest = {
      overrides: { micromatch: { braces: "3.0.3" }, "send>ms": "2.1.1" },
    }

    const { manifest, overridden } = syncManifest(host, nested)

    expect(manifest.overrides).toEqual({
      "debug@^2": "2.6.9",
      micromatch: { braces: "3.0.3" },
      "send>ms": "2.1.1",
    })
    expect(overridden).toEqual([
      {
        field: "overrides",
        name: "micromatch",
        hostValue: { picomatch: "^2.3.1" },
        nestedValue: { braces: "3.0.3" },
      },
    ])
    expect(manifest["bun-nested-workspace"]?.synced).toEqual({
      overrides: ["micromatch", "send>ms"],
    })
  })

  test("rejects overrides that Bun skips", () => {
    expect(() => syncManifest({ ...config() }, { overrides: { "a/b/c": "1.0.0" } })).toThrow(
      'nested/package.json override "a/b/c" nests deeper than one level, which Bun ignores',
    )
    expect(() => syncManifest({ overrides: { a: "-" }, ...config() }, {})).toThrow(
      'package.json override "a" has the value "-", which Bun ignores',
    )
  })

  test("rejects two overrides that select the same packages, because the merge reorders them", () => {
    expect(() =>
      syncManifest({ overrides: { d: "1.0.0" }, ...config() }, { overrides: { "**/d": "2.0.0" } }),
    ).toThrow(
      'The overrides "**/d" and "d" select the same packages, so Bun applies one of them depending on the order of the keys; keep one of them',
    )
    expect(() =>
      syncManifest({ ...config() }, { overrides: { p: { q: "1.0.0", "**/q": "2.0.0" } } }),
    ).toThrow('The overrides "p" > "q" and "p" > "**/q" select the same packages')
  })

  test("rejects a synced override that selects the nested root by a range its version satisfies", () => {
    const nested = (version: string | undefined, key: string): PackageManifest => ({
      name: "@nested/root",
      version,
      overrides: { [key]: { kit: "2.0.0" } },
    })

    expect(() => syncManifest({ ...config() }, nested("1.2.0", "@nested/root@^1"))).toThrow(
      'nested/package.json override "@nested/root@^1" > "kit" selects the nested root @nested/root@1.2.0 by a version range, which applies in the host but not in the nested repository; remove the range',
    )
    // The tools cannot tell how Bun matches this version, because node-semver drops the `>=0.0.0` bound.
    expect(() =>
      syncManifest({ ...config() }, nested("0.0.0-alpha", "@nested/root@>=0.0.0 <=0.0.0-beta")),
    ).toThrow("selects the nested root @nested/root@0.0.0-alpha by a version range")
    expect(() => syncManifest({ ...config() }, nested("1.2.0", "@nested/root@^2"))).not.toThrow()
    expect(() => syncManifest({ ...config() }, nested(undefined, "@nested/root@^1"))).not.toThrow()
    expect(() => syncManifest({ ...config() }, nested("1.2.0", "@nested/root"))).not.toThrow()
  })

  test("rejects resolutions on either side while overrides are synced", () => {
    const resolutions = { "is-number": "7.0.0" }

    expect(() => syncManifest({ resolutions, ...config() }, {})).toThrow(
      'The host package.json defines "resolutions"',
    )
    expect(() => syncManifest({ ...config() }, { resolutions })).toThrow(
      'nested/package.json defines "resolutions"',
    )
    expect(
      syncManifest({ resolutions, ...config({ fields: ["catalog"] }) }, { resolutions }).manifest
        .resolutions,
    ).toEqual(resolutions)
  })

  test("syncs a nested `$name` override only when the host root declares the same range", () => {
    const nested: PackageManifest = {
      dependencies: { ms: "~2.1.1" },
      overrides: { ms: "$ms" },
    }
    const host = (devDependencies: Record<string, string> = {}): PackageManifest => ({
      devDependencies,
      ...config(),
    })

    expect(syncManifest(host({ ms: "~2.1.1" }), nested).manifest.overrides).toEqual({ ms: "$ms" })
    expect(() => syncManifest(host({ ms: "^2.0.0" }), nested)).toThrow(
      'nested/package.json override "ms": "$ms" refers to "~2.1.1" in the nested root, but the host root declares "^2.0.0"',
    )
    expect(() => syncManifest(host(), nested)).toThrow("but the host root does not declare it")
    expect(() => syncManifest(host({ ms: "~2.1.1" }), { overrides: { ms: "$ms" } })).toThrow(
      "refers to a dependency that the root does not declare",
    )
  })

  test("checks a nested `$name` override inside a group against the host root", () => {
    const nested: PackageManifest = {
      dependencies: { ms: "~2.1.1" },
      overrides: { send: { ms: "$ms" } },
    }

    expect(
      syncManifest({ devDependencies: { ms: "~2.1.1" }, ...config() }, nested).manifest.overrides,
    ).toEqual({ send: { ms: "$ms" } })
    expect(() => syncManifest({ devDependencies: { ms: "^2.0.0" }, ...config() }, nested)).toThrow(
      'nested/package.json override "ms": "$ms" refers to "~2.1.1" in the nested root, but the host root declares "^2.0.0"',
    )
  })

  test("syncs patched dependencies with paths inside the nested directory", () => {
    const host: PackageManifest = {
      patchedDependencies: {
        "lodash@4.17.21": "patches/lodash@4.17.21.patch",
        "removed@1.0.0": "nested/patches/removed@1.0.0.patch",
      },
      ...config(),
    }
    const nested: PackageManifest = {
      patchedDependencies: { "exceljs@4.4.0": "patches/exceljs@4.4.0.patch" },
    }

    expect(syncManifest(host, nested).manifest.patchedDependencies).toEqual({
      "exceljs@4.4.0": "nested/patches/exceljs@4.4.0.patch",
      "lodash@4.17.21": "patches/lodash@4.17.21.patch",
    })
  })

  test("rejects a package version patched by both the host and the nested repository", () => {
    const host: PackageManifest = {
      patchedDependencies: { "exceljs@4.4.0": "patches/exceljs@4.4.0.patch" },
      ...config(),
    }
    const nested: PackageManifest = {
      patchedDependencies: { "exceljs@4.4.0": "patches/exceljs@4.4.0.patch" },
    }

    expect(() => syncManifest(host, nested)).toThrow("Both the host and nested patch exceljs@4.4.0")
  })

  test("syncs trusted dependencies", () => {
    const host: PackageManifest = { trustedDependencies: ["sharp", "esbuild"], ...config() }
    const nested: PackageManifest = { trustedDependencies: ["esbuild", "core-js"] }

    const { manifest } = syncManifest(host, nested)

    expect(manifest.trustedDependencies).toEqual(["core-js", "esbuild", "sharp"])
    expect(manifest["bun-nested-workspace"]?.synced).toEqual({ trustedDependencies: ["core-js"] })
  })

  test("keeps an empty trusted list, which disables the default trusted list of Bun", () => {
    const hostEmpty = syncManifest({ trustedDependencies: [], ...config() }, {})
    const nestedEmpty = syncManifest({ ...config() }, { trustedDependencies: [] })
    const syncedDropped = syncManifest(
      {
        trustedDependencies: ["esbuild"],
        ...config({ synced: { trustedDependencies: ["esbuild"] } }),
      },
      {},
    )

    expect(hostEmpty.manifest.trustedDependencies).toEqual([])
    expect(nestedEmpty.manifest.trustedDependencies).toEqual([])
    expect(syncedDropped.manifest.trustedDependencies).toEqual([])
  })

  test("reports adding trusted dependencies to a host without them", () => {
    const nested: PackageManifest = { trustedDependencies: ["esbuild"] }

    expect(syncManifest({ ...config() }, nested).addedTrustedDependencies).toBe(true)
    expect(
      syncManifest({ trustedDependencies: [], ...config() }, nested).addedTrustedDependencies,
    ).toBe(false)
    expect(
      syncManifest({ ...config() }, { trustedDependencies: [] }).addedTrustedDependencies,
    ).toBe(true)
    expect(syncManifest({ ...config() }, {}).addedTrustedDependencies).toBe(false)

    const unsynced = syncManifest({ ...config({ fields: ["overrides"] }) }, nested)
    expect(unsynced.addedTrustedDependencies).toBe(false)
    expect(unsynced.manifest).not.toHaveProperty("trustedDependencies")
  })

  test("syncs only the configured fields", () => {
    const host: PackageManifest = { trustedDependencies: [], ...config({ fields: ["overrides"] }) }
    const nested: PackageManifest = {
      overrides: { semver: "^7.0.0" },
      trustedDependencies: ["esbuild"],
    }

    const { manifest } = syncManifest(host, nested)

    expect(manifest.overrides).toEqual({ semver: "^7.0.0" })
    expect(manifest.trustedDependencies).toEqual([])
  })

  describe("conflicts", () => {
    test("replaces a different host entry with the nested one and reports it", () => {
      const host: PackageManifest = {
        workspaces: { catalog: { h3: "^1.15.5", "@orpc/client": "2.0.0" } },
        ...config(),
      }
      const nested: PackageManifest = { workspaces: { catalog: { h3: "^1.15.3" } } }

      const { manifest, overridden } = syncManifest(host, nested)

      expect(getCatalogs(manifest).catalog).toEqual({ "@orpc/client": "2.0.0", h3: "^1.15.3" })
      expect(overridden).toEqual([
        { field: "catalog", name: "h3", hostValue: "^1.15.5", nestedValue: "^1.15.3" },
      ])
      expect(manifest["bun-nested-workspace"]?.synced).toEqual({ catalog: ["h3"] })
    })

    test("keeps a host entry equal to the nested one as the host's own", () => {
      const host: PackageManifest = { overrides: { semver: "^7.0.0" }, ...config() }
      const nested: PackageManifest = { overrides: { semver: "^7.0.0" } }

      const first = syncManifest(host, nested)
      const second = syncManifest(first.manifest, {})

      expect(first.overridden).toEqual([])
      expect(second.manifest.overrides).toEqual({ semver: "^7.0.0" })
    })

    test("keeps a host group equal to the nested one in another key order as the host's own", () => {
      const host: PackageManifest = {
        overrides: { send: { ms: "2.1.1", debug: "2.6.9" } },
        ...config(),
      }
      const nested: PackageManifest = { overrides: { send: { debug: "2.6.9", ms: "2.1.1" } } }

      const { manifest, overridden } = syncManifest(host, nested)

      expect(overridden).toEqual([])
      expect(manifest["bun-nested-workspace"]?.synced).toBeUndefined()
    })

    test("updates synced entries silently and removes those the nested repository dropped", () => {
      const host: PackageManifest = {
        overrides: { semver: "^7.0.0", dropped: "1.0.0", updated: "1.0.0" },
        ...config({ synced: { overrides: ["dropped", "updated"] } }),
      }
      const nested: PackageManifest = { overrides: { updated: "2.0.0" } }

      const { manifest, overridden } = syncManifest(host, nested)

      expect(manifest.overrides).toEqual({ semver: "^7.0.0", updated: "2.0.0" })
      expect(manifest["bun-nested-workspace"]?.synced).toEqual({ overrides: ["updated"] })
      expect(overridden).toEqual([])
    })

    test("removes a synced field that became empty", () => {
      const host: PackageManifest = {
        workspaces: { packages: ["nested/*"], catalog: { zod: "^4.0.0" } },
        overrides: { semver: "^7.0.0" },
        ...config({ synced: { catalog: ["zod"], overrides: ["semver"] } }),
      }

      const { manifest } = syncManifest(host, {})

      expect(manifest.workspaces).toEqual({ packages: ["nested/*"] })
      expect(manifest).not.toHaveProperty("overrides")
      expect(manifest["bun-nested-workspace"]).toEqual({ dir: "nested" })
    })
  })
})

describe("diffManifests", () => {
  test("reports differences of synced fields and entry lists, ignoring order", () => {
    const expected: PackageManifest = {
      workspaces: { catalog: { h3: "^1.15.3", zod: "^4.0.0" } },
      trustedDependencies: ["core-js", "esbuild"],
      "bun-nested-workspace": { dir: "nested", synced: { catalog: ["h3"] } },
    }
    const actual: PackageManifest = {
      workspaces: { catalog: { zod: "^4.0.0", h3: "^1.15.5" } },
      trustedDependencies: ["esbuild", "core-js"],
      "bun-nested-workspace": { dir: "nested" },
    }

    expect(diffManifests(expected, actual)).toEqual([
      { path: "bun-nested-workspace.synced.catalog", expected: ["h3"], actual: undefined },
      { path: "catalog.h3", expected: "^1.15.3", actual: "^1.15.5" },
    ])
  })
})
