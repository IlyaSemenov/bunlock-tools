import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { parseLockfile } from "bun-nested-workspace"

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

function run(cwd: string, command: string[]) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

function runCli(...args: string[]) {
  return run(root, [process.execPath, cliPath, ...args])
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
      workspaces: ["apps/*", "nested/packages/*"],
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
  expect(
    run(path.join(root, "nested"), [process.execPath, "install", "--lockfile-only"]).exitCode,
  ).toBe(0)
  expect(run(root, [process.execPath, "install", "--lockfile-only"]).exitCode).toBe(0)
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

    const sync = runCli("--lockfile-only")

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

    const check = runCli("--check")
    expect(check.exitCode, check.output).toBe(0)
  })

  test("lists host entries replaced by nested ones", async () => {
    await createFixture()
    const manifest = await readJson("package.json")
    await writeFiles({ "package.json": { ...manifest, catalog: { "nested-only": "^1.0.0" } } })

    const sync = runCli("--lockfile-only")

    expect(sync.exitCode, sync.output).toBe(0)
    expect(sync.output).toContain('catalog.nested-only: "^1.0.0" → "^2.0.0"')
  })

  test("fails before writing when host workspaces miss nested packages", async () => {
    await createFixture()
    const manifest = await readJson("package.json")
    await writeFiles({ "package.json": { ...manifest, workspaces: ["apps/*"] } })

    const sync = runCli("--lockfile-only")

    expect(sync.exitCode).toBe(1)
    expect(sync.output).toContain(
      "does not include nested workspaces: nested/packages/core, nested/packages/util",
    )
    expect(await readJson("package.json")).not.toHaveProperty("trustedDependencies")
  })
})

describe("--check", () => {
  test("fails when the nested checkout is ahead of the host", async () => {
    await createFixture()
    expect(runCli("--lockfile-only").exitCode).toBe(0)
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
    expect(
      run(path.join(root, "nested"), [process.execPath, "install", "--lockfile-only"]).exitCode,
    ).toBe(0)

    const check = runCli("--check")

    expect(check.exitCode).toBe(1)
    expect(check.output).toContain('catalog.nested-only: "^2.0.0" → "^2.1.0"')
    expect(check.output).toContain("bun.lock workspaces:\n    nested/packages/core")
  })

  test("writes nothing", async () => {
    await createFixture()
    const manifestText = await Bun.file(path.join(root, "package.json")).text()
    const lockText = await Bun.file(path.join(root, "bun.lock")).text()

    expect(runCli("--check").exitCode).toBe(1)
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

    const check = runCli("--check")

    expect(check.exitCode).toBe(1)
    expect(check.output).toContain("has lockfileVersion 99, supported versions: 1, 2")
  })

  test("reports configuration errors as a message", async () => {
    await writeFiles({ "package.json": { name: "@host/root" } })

    const check = runCli("--check")

    expect(check.exitCode).toBe(1)
    expect(check.output.trim()).toBe(
      'package.json has no "bun-nested-workspace" field with the nested directory',
    )
  })

  test("rejects other options", async () => {
    const check = runCli("--check", "--frozen-lockfile")

    expect(check.exitCode).toBe(1)
    expect(check.output).toContain("--check takes no other options, got --frozen-lockfile")
  })
})
