import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { parseLockfile } from "bun-nested-workspace"
import { resolveDependencyLockKey } from "bunlock-lockfile"

import type { Registry } from "./registry"
import { startRegistry } from "./registry"

const cliPath = path.join(import.meta.dir, "../src/cli.ts")

let root: string

/** Writes files relative to the fixture root, serializing non-string contents as JSON. */
async function writeFiles(files: Record<string, unknown>) {
  for (const [file, content] of Object.entries(files)) {
    await Bun.write(
      path.join(root, file),
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    )
  }
}

async function readJson(file: string) {
  return Bun.file(path.join(root, file)).json()
}

/** Runs a command asynchronously, so that a registry served by this process can respond. */
async function run(cwd: string, command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: `${stdout}${stderr}` }
}

function runCli(...args: string[]) {
  return run(root, [process.execPath, cliPath, ...args])
}

/** Runs `bun install --lockfile-only` with extra arguments in a nested package directory, where Bun treats the nested root as the workspace root. */
function updateNestedLockfile(args: string[] = [], env?: Record<string, string>) {
  return run(
    path.join(root, "nested/packages/core"),
    [process.execPath, "install", "--lockfile-only", ...args],
    env,
  )
}

/** Starts a registry with versions of the package `tool`, whose binary prints its version. */
function startToolRegistry(versions: string[]) {
  return startRegistry(
    versions.map(version => ({
      name: "tool",
      version,
      bin: { tool: "cli.js" },
      files: { "cli.js": `console.log("tool ${version}")` },
    })),
  )
}

/** Returns the environment that makes `bun install` use the registry and a cache inside the fixture. */
function getRegistryEnv(registry: Registry) {
  return { BUN_CONFIG_REGISTRY: registry.url, BUN_INSTALL_CACHE_DIR: path.join(root, ".cache") }
}

/** Runs the `tool` binary installed for a fixture directory and returns its output. */
async function runTool(dir: string) {
  return (
    await run(root, [process.execPath, path.join(root, dir, "node_modules/.bin/tool")])
  ).output.trim()
}

/**
 * Creates a host with a nested checkout whose lockfile is up to date.
 *
 * Packages are local, so bun install works offline; the catalog points at a workspace package for the same reason.
 */
async function createFixture() {
  await writeFiles({
    "package.json": {
      name: "@host/root",
      private: true,
      workspaces: ["apps/*", "nested", "nested/packages/*"],
      catalog: { "@nested/core": "workspace:*", "host-only": "^1.0.0" },
      "bun-nested-workspace": { dir: "nested" },
    },
    "apps/web/package.json": {
      name: "@host/web",
      dependencies: { "@nested/core": "workspace:*" },
    },
    "nested/package.json": {
      name: "@nested/root",
      private: true,
      workspaces: {
        packages: ["packages/*"],
        catalog: { "@nested/core": "workspace:*", "nested-only": "^2.0.0" },
      },
      trustedDependencies: ["esbuild"],
    },
    "nested/packages/core/package.json": { name: "@nested/core" },
    "nested/packages/util/package.json": {
      name: "@nested/util",
      dependencies: { "@nested/core": "catalog:" },
    },
  })
  expect((await updateNestedLockfile()).exitCode).toBe(0)
  expect((await run(root, [process.execPath, "install", "--lockfile-only"])).exitCode).toBe(0)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bun-nested-workspace-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("sync", () => {
  test("syncs root fields and the lockfile so that --check passes", async () => {
    await createFixture()

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode, sync.output).toBe(0)
    expect(await readJson("package.json")).toMatchObject({
      catalog: { "@nested/core": "workspace:*", "host-only": "^1.0.0", "nested-only": "^2.0.0" },
      trustedDependencies: ["esbuild"],
      "bun-nested-workspace": {
        dir: "nested",
        synced: { catalog: ["nested-only"], trustedDependencies: ["esbuild"] },
      },
    })
    const lock = parseLockfile(await Bun.file(path.join(root, "bun.lock")).text())
    expect(lock.packages["@nested/util"]).toEqual(["@nested/util@workspace:nested/packages/util"])

    const check = await runCli("--check")
    expect(check.exitCode, check.output).toBe(0)
  })

  test("installs the dependencies of the nested root in the versions of the nested lockfile and runs its prepare script", async () => {
    await using registry = await startToolRegistry(["1.0.0", "2.0.0", "2.1.0"])
    const env = getRegistryEnv(registry)
    const nestedManifest = {
      name: "@nested/root",
      private: true,
      workspaces: ["packages/*"],
      scripts: { prepare: "echo prepared > prepared.txt" },
    }
    await writeFiles({
      "package.json": {
        name: "@host/root",
        private: true,
        workspaces: ["nested", "nested/packages/*"],
        devDependencies: { tool: "1.0.0" },
        "bun-nested-workspace": { dir: "nested" },
      },
      "nested/package.json": nestedManifest,
      "nested/packages/core/package.json": { name: "@nested/core" },
    })
    expect((await updateNestedLockfile([], env)).exitCode).toBe(0)
    expect((await run(root, [process.execPath, "install", "--lockfile-only"], env)).exitCode).toBe(
      0,
    )
    await writeFiles({
      "nested/package.json": { ...nestedManifest, devDependencies: { tool: "2.0.0" } },
    })
    expect((await updateNestedLockfile([], env)).exitCode).toBe(0)

    const sync = await run(root, [process.execPath, cliPath], env)

    expect(sync.exitCode, sync.output).toBe(0)
    expect(await runTool("nested")).toBe("tool 2.0.0")
    expect(await runTool(".")).toBe("tool 1.0.0")
    expect(await Bun.file(path.join(root, "nested/prepared.txt")).exists()).toBe(true)
    const check = await runCli("--check")
    expect(check.exitCode, check.output).toBe(0)

    // The host lockfile now records 2.0.0 under the nested root, which still satisfies the new range.
    await writeFiles({
      "nested/package.json": { ...nestedManifest, devDependencies: { tool: "^2.0.0" } },
    })
    await rm(path.join(root, "nested/bun.lock"))
    expect((await updateNestedLockfile([], env)).exitCode).toBe(0)

    const resync = await run(root, [process.execPath, cliPath], env)

    expect(resync.exitCode, resync.output).toBe(0)
    expect(await runTool("nested")).toBe("tool 2.1.0")
  })

  test("keeps the nested root version of a dependency that the host root resolves to a newer version", async () => {
    await using registry = await startToolRegistry(["1.6.0", "1.8.5"])
    const env = getRegistryEnv(registry)
    const nestedManifest = { name: "@nested/root", private: true, workspaces: ["packages/*"] }
    await writeFiles({
      "package.json": {
        name: "@host/root",
        private: true,
        workspaces: ["nested", "nested/packages/*"],
        devDependencies: { tool: "^1.7.0" },
        "bun-nested-workspace": { dir: "nested" },
      },
      "nested/package.json": { ...nestedManifest, devDependencies: { tool: "1.6.0" } },
      "nested/packages/core/package.json": { name: "@nested/core" },
    })
    expect((await updateNestedLockfile([], env)).exitCode).toBe(0)
    // The nested lockfile keeps 1.6.0; the host version also satisfies ^1.6.0.
    await writeFiles({
      "nested/package.json": { ...nestedManifest, devDependencies: { tool: "^1.6.0" } },
    })
    expect((await updateNestedLockfile([], env)).exitCode).toBe(0)
    expect((await run(root, [process.execPath, "install", "--lockfile-only"], env)).exitCode).toBe(
      0,
    )

    const sync = await run(root, [process.execPath, cliPath], env)

    expect(sync.exitCode, sync.output).toBe(0)
    expect(await runTool("nested")).toBe("tool 1.6.0")
    expect(await runTool(".")).toBe("tool 1.8.5")
    const check = await runCli("--check")
    expect(check.exitCode, check.output).toBe(0)
  })

  test("keeps the nested resolutions that an override scoped to a parent version selects", async () => {
    await using registry = await startRegistry([
      { name: "leaf", version: "1.0.0" },
      { name: "leaf", version: "1.1.0" },
      { name: "leaf", version: "2.0.0" },
      { name: "lib", version: "1.0.0", dependencies: { leaf: "^1.0.0" } },
      { name: "lib", version: "2.0.0", dependencies: { leaf: "^1.0.0" } },
    ])
    const env = getRegistryEnv(registry)
    await writeFiles({
      "package.json": {
        name: "@host/root",
        private: true,
        workspaces: ["apps/*", "nested", "nested/packages/*"],
        "bun-nested-workspace": { dir: "nested" },
      },
      "apps/web/package.json": { name: "@host/web", dependencies: { lib: "1.0.0" } },
      "nested/package.json": {
        name: "@nested/root",
        private: true,
        workspaces: ["packages/*"],
        overrides: { "lib@^2>leaf": "2.0.0" },
      },
      "nested/packages/core/package.json": { name: "@nested/core", dependencies: { lib: "2.0.0" } },
    })
    expect((await updateNestedLockfile([], env)).exitCode).toBe(0)
    expect((await run(root, [process.execPath, "install", "--lockfile-only"], env)).exitCode).toBe(
      0,
    )

    const sync = await run(root, [process.execPath, cliPath, "--lockfile-only"], env)

    expect(sync.exitCode, sync.output).toBe(0)
    const lock = parseLockfile(await Bun.file(path.join(root, "bun.lock")).text())
    expect(lock.lockfileVersion).toBe(3)
    expect(lock.overrides).toEqual({ "lib@^2": { leaf: "2.0.0" } })
    const resolve = (dependent: string, dependency: string) => {
      const key = resolveDependencyLockKey(dependent, dependency, lock.packages)!
      return { key, resolution: lock.packages[key]![0] }
    }
    const hostLib = resolve("@host/web", "lib")
    const nestedLib = resolve("@nested/core", "lib")
    expect(hostLib.resolution).toBe("lib@1.0.0")
    expect(resolve(hostLib.key, "leaf").resolution).toBe("leaf@1.1.0")
    expect(nestedLib.resolution).toBe("lib@2.0.0")
    expect(resolve(nestedLib.key, "leaf").resolution).toBe("leaf@2.0.0")
    const check = await runCli("--check")
    expect(check.exitCode, check.output).toBe(0)
  })

  test("syncs a nested root entry without a name, which Bun keeps when the name is added later", async () => {
    await createFixture()
    const { name, ...nestedManifest } = await readJson("nested/package.json")
    await writeFiles({ "nested/package.json": nestedManifest })
    await rm(path.join(root, "nested/bun.lock"))
    expect((await updateNestedLockfile()).exitCode).toBe(0)
    await writeFiles({ "nested/package.json": { name, ...nestedManifest } })
    expect((await updateNestedLockfile(["--frozen-lockfile"])).exitCode).toBe(0)
    expect(await Bun.file(path.join(root, "nested/bun.lock")).text()).not.toContain(name)

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode, sync.output).toBe(0)
    const check = await runCli("--check")
    expect(check.exitCode, check.output).toBe(0)
  })

  test("lists host entries replaced by nested ones", async () => {
    await createFixture()
    const manifest = await readJson("package.json")
    await writeFiles({ "package.json": { ...manifest, catalog: { "nested-only": "^1.0.0" } } })

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode, sync.output).toBe(0)
    expect(sync.output).toContain('catalog.nested-only: "^1.0.0" → "^2.0.0"')
  })

  test("warns once when the sync adds trustedDependencies to the host", async () => {
    await createFixture()

    const sync1 = await runCli("--lockfile-only")
    const sync2 = await runCli("--lockfile-only")

    expect(sync1.exitCode, sync1.output).toBe(0)
    expect(sync1.output).toContain("The sync added trustedDependencies to the host package.json.")
    expect(sync2.exitCode, sync2.output).toBe(0)
    expect(sync2.output).not.toContain("trustedDependencies")
  })

  test("warns about added trustedDependencies when bun install fails", async () => {
    await createFixture()

    const sync = await runCli("--no-such-flag")

    expect(sync.exitCode).toBe(1)
    expect(sync.output).toContain("The sync added trustedDependencies to the host package.json.")
  })

  describe("failure after writing", () => {
    /** Returns the texts of the host `package.json` and `bun.lock`. */
    async function readHostFiles() {
      return Promise.all(
        ["package.json", "bun.lock"].map(file => Bun.file(path.join(root, file)).text()),
      )
    }

    test("restores the host files when bun install fails", async () => {
      await createFixture()
      const hostFiles = await readHostFiles()

      const sync = await runCli("--no-such-flag")

      expect(sync.exitCode).toBe(1)
      expect(sync.output).toContain("Restored package.json and bun.lock")
      expect(await readHostFiles()).toEqual(hostFiles)
    })

    test("restores a package.json that a failed lifecycle script changed", async () => {
      await createFixture()
      expect((await runCli("--lockfile-only")).exitCode).toBe(0)
      const manifest = await readJson("package.json")
      await writeFiles({
        "package.json": {
          ...manifest,
          scripts: { postinstall: `echo '{}' > package.json && exit 1` },
        },
      })
      const hostFiles = await readHostFiles()

      const sync = await runCli()

      expect(sync.exitCode).toBe(1)
      expect(sync.output).toContain("Restored package.json and bun.lock")
      expect(await readHostFiles()).toEqual(hostFiles)
    })

    test("restores the host files when the sync changes own dependencies of host packages", async () => {
      await using registry = await startToolRegistry(["1.0.0", "2.0.0"])
      const env = getRegistryEnv(registry)
      await createFixture()
      const webManifest = await readJson("apps/web/package.json")
      await writeFiles({
        "apps/web/package.json": { ...webManifest, dependencies: { tool: "^1.0.0" } },
      })
      expect(
        (await run(root, [process.execPath, "install", "--lockfile-only"], env)).exitCode,
      ).toBe(0)
      // An edit without bun install, so that the host lockfile does not pin the dependency.
      await writeFiles({
        "apps/web/package.json": { ...webManifest, dependencies: { tool: "^2.0.0" } },
      })
      const hostFiles = await readHostFiles()

      const sync = await run(root, [process.execPath, cliPath, "--lockfile-only"], env)

      expect(sync.exitCode).toBe(1)
      expect(sync.output).toContain("@host/web > tool: tool@1.0.0 → tool@2.0.0")
      expect(sync.output).toContain("Restored package.json and bun.lock")
      expect(await readHostFiles()).toEqual(hostFiles)
    })

    test("reports an outdated nested lockfile and restores the host files", async () => {
      await createFixture()
      await writeFiles({
        "nested/packages/core/package.json": {
          name: "@nested/core",
          dependencies: { "@nested/util": "workspace:*" },
        },
      })
      const hostFiles = await readHostFiles()

      const sync = await runCli("--lockfile-only")

      expect(sync.exitCode).toBe(1)
      expect(sync.output).toContain(
        "nested/bun.lock lags behind the package.json files of nested. Update it and sync again:\n  (cd nested/packages/core && bun install --lockfile-only)",
      )
      expect(sync.output).toContain("Restored package.json and bun.lock")
      expect(await readHostFiles()).toEqual(hostFiles)
    })

    test("names a package directory that the nested workspaces patterns include", async () => {
      await createFixture()
      const nestedManifest = await readJson("nested/package.json")
      await writeFiles({
        "nested/package.json": {
          ...nestedManifest,
          workspaces: {
            ...nestedManifest.workspaces,
            packages: [".", "packages/*", "!packages/core"],
          },
        },
        "nested/packages/util/package.json": { name: "@nested/util" },
      })

      const sync = await runCli("--lockfile-only")

      expect(sync.exitCode).toBe(1)
      expect(sync.output).toContain("(cd nested/packages/util && bun install --lockfile-only)")
    })

    test("does not blame the nested lockfile for a host workspace that the nested repository does not have", async () => {
      await createFixture()
      const nestedManifest = await readJson("nested/package.json")
      await writeFiles({
        "nested/package.json": {
          ...nestedManifest,
          workspaces: {
            ...nestedManifest.workspaces,
            packages: ["packages/core", "packages/util"],
          },
        },
      })
      expect((await updateNestedLockfile()).exitCode).toBe(0)
      await writeFiles({ "nested/packages/example/package.json": { name: "@nested/example" } })

      const sync = await runCli("--lockfile-only")

      expect(sync.exitCode).toBe(1)
      expect(sync.output).toContain("bun.lock workspaces:\n    nested/packages/example")
      expect(sync.output).not.toContain("lags behind")
    })
  })

  test("fails before writing when host workspaces miss nested packages", async () => {
    await createFixture()
    const manifest = await readJson("package.json")
    await writeFiles({ "package.json": { ...manifest, workspaces: ["apps/*"] } })

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode).toBe(1)
    expect(sync.output).toContain(
      "does not include nested workspaces: nested, nested/packages/core, nested/packages/util",
    )
    expect(await readJson("package.json")).not.toHaveProperty("trustedDependencies")
  })

  test("fails before writing when the nested root has no name", async () => {
    await createFixture()
    const { name: _name, ...nestedManifest } = await readJson("nested/package.json")
    await writeFiles({ "nested/package.json": nestedManifest })

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode).toBe(1)
    expect(sync.output).toContain(
      'nested/package.json needs a "name" field to be a workspace of the host',
    )
    expect(await readJson("package.json")).not.toHaveProperty("trustedDependencies")
  })

  test("fails before writing when an override refers to a dependency the root does not declare", async () => {
    await createFixture()
    const manifest = await readJson("package.json")
    await writeFiles({ "package.json": { ...manifest, overrides: { "left-pad": "$left-pad" } } })
    const lockText = await Bun.file(path.join(root, "bun.lock")).text()

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode).toBe(1)
    expect(sync.output).toContain(
      'package.json override "left-pad": "$left-pad" refers to a dependency that the root does not declare',
    )
    expect(await readJson("package.json")).not.toHaveProperty("trustedDependencies")
    expect(await Bun.file(path.join(root, "bun.lock")).text()).toBe(lockText)
  })

  test("fails before writing when Bun skips a nested override", async () => {
    await createFixture()
    const nestedManifest = await readJson("nested/package.json")
    await writeFiles({
      "nested/package.json": {
        ...nestedManifest,
        overrides: { "is-odd": { "is-number": "github:owner/repo#bad\nref" } },
      },
    })
    expect((await updateNestedLockfile()).exitCode).toBe(0)
    const lockText = await Bun.file(path.join(root, "bun.lock")).text()

    const sync = await runCli("--lockfile-only")

    expect(sync.exitCode).toBe(1)
    expect(sync.output).toContain(
      'nested/bun.lock does not record the overrides of nested/package.json as Bun reads them: "is-odd"',
    )
    expect(await readJson("package.json")).not.toHaveProperty("trustedDependencies")
    expect(await Bun.file(path.join(root, "bun.lock")).text()).toBe(lockText)
  })
})

describe("--check", () => {
  test("fails when the nested checkout is ahead of the host", async () => {
    await createFixture()
    expect((await runCli("--lockfile-only")).exitCode).toBe(0)
    const nestedManifest = await readJson("nested/package.json")
    await writeFiles({
      "nested/package.json": {
        ...nestedManifest,
        workspaces: {
          ...nestedManifest.workspaces,
          catalog: { ...nestedManifest.workspaces.catalog, "nested-only": "^2.1.0" },
        },
      },
      "nested/packages/core/package.json": {
        name: "@nested/core",
        dependencies: { "@nested/util": "workspace:*" },
      },
    })
    expect((await updateNestedLockfile()).exitCode).toBe(0)

    const check = await runCli("--check")

    expect(check.exitCode).toBe(1)
    expect(check.output).toContain("package.json and bun.lock differ from nested (host → nested):")
    expect(check.output).toContain('catalog.nested-only: "^2.0.0" → "^2.1.0"')
    expect(check.output).toContain("bun.lock workspaces:\n    nested/packages/core")
  })

  test("writes nothing", async () => {
    await createFixture()
    const manifestText = await Bun.file(path.join(root, "package.json")).text()
    const lockText = await Bun.file(path.join(root, "bun.lock")).text()

    expect((await runCli("--check")).exitCode).toBe(1)
    expect(await Bun.file(path.join(root, "package.json")).text()).toBe(manifestText)
    expect(await Bun.file(path.join(root, "bun.lock")).text()).toBe(lockText)
  })

  test("rejects an unknown lockfileVersion", async () => {
    await createFixture()
    const lockPath = path.join(root, "nested/bun.lock")
    await Bun.write(
      lockPath,
      (await Bun.file(lockPath).text()).replace(/"lockfileVersion": \d+/, '"lockfileVersion": 99'),
    )

    const check = await runCli("--check")

    expect(check.exitCode).toBe(1)
    expect(check.output).toContain("has lockfileVersion 99, supported versions: 1, 2")
  })

  test("reports configuration errors as a message", async () => {
    await writeFiles({ "package.json": { name: "@host/root" } })

    const check = await runCli("--check")

    expect(check.exitCode).toBe(1)
    expect(check.output.trim()).toBe(
      'package.json has no "bun-nested-workspace" field with the nested directory',
    )
  })

  test("rejects other options", async () => {
    const check = await runCli("--check", "--frozen-lockfile")

    expect(check.exitCode).toBe(1)
    expect(check.output).toContain("--check takes no other options, got --frozen-lockfile")
  })
})

describe("bun install --lockfile-only in a nested package directory", () => {
  test("writes the nested lockfile as in a separate clone and leaves the host lockfile", async () => {
    await createFixture()
    await writeFiles({
      "nested/packages/core/package.json": {
        name: "@nested/core",
        dependencies: { "@nested/util": "workspace:*" },
      },
    })
    const clone = await mkdtemp(path.join(tmpdir(), "bun-nested-workspace-clone-"))
    try {
      await cp(path.join(root, "nested"), clone, { recursive: true })
      const lockText = await Bun.file(path.join(root, "bun.lock")).text()

      expect((await updateNestedLockfile()).exitCode).toBe(0)
      expect((await run(clone, [process.execPath, "install", "--lockfile-only"])).exitCode).toBe(0)

      expect(await Bun.file(path.join(root, "nested/bun.lock")).text()).toBe(
        await Bun.file(path.join(clone, "bun.lock")).text(),
      )
      expect(await Bun.file(path.join(root, "nested/bun.lock")).text()).toContain(
        '"@nested/util": "workspace:*"',
      )
      expect(await Bun.file(path.join(root, "bun.lock")).text()).toBe(lockText)
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  })
})
