import path from "node:path"

import { renderBunLock } from "bunlock-lockfile"

import type { DependencyMismatch, PackageMismatch } from "./check"
import {
  findDirectDependencyMismatches,
  findOwnDependencyChanges,
  findTransitiveMismatches,
  findUncoveredWorkspaces,
  findWorkspaceMismatches,
  getWorkspacePatterns,
  matchesWorkspacePatterns,
} from "./check"
import { getErrorMessage } from "./errors"
import type { Lockfile } from "./lockfile"
import {
  applyManifestToLockfile,
  assertOverridesRecorded,
  mergeLockfiles,
  readLockfile,
  relocateLockfile,
} from "./lockfile"
import type { ManifestDifference, ManifestSync, PackageManifest, ResolvedConfig } from "./manifest"
import { diffManifests, readConfig, syncManifest } from "./manifest"
import { isNestedPath } from "./paths"

/** Host and nested root files loaded from disk. */
export interface NestedWorkspace {
  /** Absolute path of the host root. */
  root: string
  config: ResolvedConfig
  manifest: PackageManifest
  /** Original text of the host `package.json`, used to preserve its formatting. */
  manifestText: string
  nestedManifest: PackageManifest
  lock: Lockfile
  /** Nested lockfile relocated with `relocateLockfile`, with the root name of `nestedManifest`. */
  nestedLock: Lockfile
}

/** Loads the root `package.json` and `bun.lock` files of the host and of the nested checkout. */
export async function loadNestedWorkspace(root: string): Promise<NestedWorkspace> {
  const manifestText = await Bun.file(path.join(root, "package.json")).text()
  const manifest = JSON.parse(manifestText) as PackageManifest
  const config = readConfig(manifest)
  const nestedRoot = path.join(root, config.dir)
  const nestedManifest = (await Bun.file(
    path.join(nestedRoot, "package.json"),
  ).json()) as PackageManifest

  return {
    root,
    config,
    manifest,
    manifestText,
    nestedManifest,
    lock: await readLockfile(path.join(root, "bun.lock")),
    nestedLock: relocateLockfile(
      await readLockfile(path.join(nestedRoot, "bun.lock")),
      config.dir,
      typeof nestedManifest.name === "string" ? nestedManifest.name : undefined,
    ),
  }
}

/**
 * Returns whether a workspace path of the host lockfile is a workspace of the nested repository:
 * its root, a workspace of the nested lockfile, or a directory that the nested `workspaces` patterns include.
 */
export function isNestedWorkspace(workspace: NestedWorkspace, workspacePath: string): boolean {
  const { dir } = workspace.config
  return (
    workspacePath === dir ||
    workspacePath in workspace.nestedLock.workspaces ||
    (isNestedPath(workspacePath, dir) &&
      matchesWorkspacePatterns(
        getWorkspacePatterns(workspace.nestedManifest),
        workspacePath.slice(dir.length + 1),
      ))
  )
}

/**
 * Returns the first directory with a named package that the nested `workspaces` patterns include, relative to the host root.
 *
 * `bun install` treats the nested root as the workspace root there and writes the nested lockfile,
 * while in the nested root itself it writes the host lockfile.
 */
export async function findNestedPackageDir(
  workspace: NestedWorkspace,
): Promise<string | undefined> {
  const nestedRoot = path.join(workspace.root, workspace.config.dir)
  const patterns = getWorkspacePatterns(workspace.nestedManifest)
  const dirs = new Set<string>()
  for (const pattern of patterns.included) {
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(nestedRoot)) {
      const dir = path.posix.normalize(path.posix.dirname(file.split(path.sep).join("/")))
      if (matchesWorkspacePatterns(patterns, dir)) {
        dirs.add(dir)
      }
    }
  }
  for (const dir of [...dirs].sort()) {
    const manifest = (await Bun.file(
      path.join(nestedRoot, dir, "package.json"),
    ).json()) as PackageManifest
    if (typeof manifest.name === "string" && manifest.name) {
      return `${workspace.config.dir}/${dir}`
    }
  }
  return undefined
}

/** Differences between the host files and the nested checkout; all lists are empty when the host is in sync. */
export interface CheckResult {
  /** Synced root fields of the host `package.json` that differ from the nested ones. */
  manifest: ManifestDifference[]
  /** Nested workspaces whose host `bun.lock` entries differ from the nested `bun.lock`. */
  workspaces: string[]
  /** Direct dependencies of nested workspaces resolved differently than in the nested `bun.lock`. */
  directDependencies: DependencyMismatch[]
  /** Transitive dependencies of nested workspaces resolved differently than in the nested `bun.lock`. */
  transitiveDependencies: PackageMismatch[]
}

/** Returns whether a check found no differences. */
export function isInSync(result: CheckResult): boolean {
  return Object.values(result).every(list => !list.length)
}

/**
 * Throws when the host `workspaces` patterns miss nested workspaces or the nested root has no name.
 *
 * Bun would drop such workspaces from the merged lockfile, so neither mode can sync or check them.
 * Bun skips a workspace package without a name, or fails on it in versions before 1.4.
 */
export function assertWorkspacesCovered(workspace: NestedWorkspace): void {
  if (typeof workspace.nestedManifest.name !== "string" || !workspace.nestedManifest.name) {
    throw new Error(
      `${workspace.config.dir}/package.json needs a "name" field to be a workspace of the host`,
    )
  }
  const uncovered = findUncoveredWorkspaces(workspace.manifest, workspace.nestedLock)
  if (uncovered.length) {
    throw new Error(
      `The host "workspaces" field does not include nested workspaces: ${uncovered.join(", ")}`,
    )
  }
}

/** Compares the host files with the nested checkout without writing anything or running `bun install`. */
export function checkNestedWorkspace(workspace: NestedWorkspace): CheckResult {
  assertWorkspacesCovered(workspace)
  const { manifest } = syncManifest(workspace.manifest, workspace.nestedManifest)

  return {
    manifest: diffManifests(manifest, workspace.manifest),
    workspaces: findWorkspaceMismatches(workspace.lock, workspace.nestedLock, workspace.config.dir),
    directDependencies: findDirectDependencyMismatches(workspace.lock, workspace.nestedLock),
    transitiveDependencies: findTransitiveMismatches(workspace.lock, workspace.nestedLock),
  }
}

/** Error thrown when `bun install` exits with a non-zero code. */
export class BunInstallError extends Error {
  constructor(readonly exitCode: number) {
    super(`bun install exited with code ${exitCode}`)
    this.name = "BunInstallError"
  }
}

/**
 * Runs `bun install` in the host root with inherited stdio and throws `BunInstallError` on failure.
 *
 * Uses the Bun that runs this package, such as the one `bunx` started, rather than the first `bun` on `PATH`.
 */
export async function runBunInstall(root: string, args: readonly string[] = []): Promise<void> {
  const install = Bun.spawn([process.execPath, "install", ...args], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await install.exited
  if (exitCode !== 0) {
    throw new BunInstallError(exitCode)
  }
}

/** Options of `syncNestedWorkspace`. */
export interface SyncOptions {
  /** Arguments passed to `bun install`, such as `--lockfile-only`. */
  installArgs?: readonly string[]
  /**
   * Called with the result of `syncManifest` once the host `package.json` is written, before `bun install` runs.
   *
   * It reports the changes of `package.json` even when `bun install` fails and the sync throws.
   */
  onManifestSync?: (sync: ManifestSync) => void
}

/**
 * Result of `syncNestedWorkspace`.
 *
 * The sync failed and restored the host files when `ownDependencyChanges` is not empty or `isInSync(check)` is false.
 */
export interface SyncResult {
  /** Own dependencies of host workspaces that the sync re-resolved. */
  ownDependencyChanges: DependencyMismatch[]
  /** Check of the synced files. */
  check: CheckResult
}

/**
 * Syncs the host root `package.json` and `bun.lock` with the nested checkout.
 *
 * Writes the synced `package.json`, writes the merged `bun.lock`, runs `bun install`,
 * and then compares the result with the nested checkout and with the original host resolutions.
 * When `bun install` fails or the result differs, restores both files before it throws or returns,
 * so that the next sync starts from the original host resolutions.
 * Throws an error that says so when it cannot restore them.
 */
export async function syncNestedWorkspace(
  root: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const workspace = await loadNestedWorkspace(root)
  assertWorkspacesCovered(workspace)
  const manifestSync = syncManifest(workspace.manifest, workspace.nestedManifest)
  const { manifest } = manifestSync
  // The merged lockfile records the overrides of both sides, and Bun discards a lockfile with an override it skips.
  const { dir, fields } = workspace.config
  assertOverridesRecorded(workspace.manifest, workspace.lock, {
    manifest: "package.json",
    lock: "bun.lock",
  })
  if (fields.includes("overrides")) {
    assertOverridesRecorded(workspace.nestedManifest, workspace.nestedLock, {
      manifest: `${dir}/package.json`,
      lock: `${dir}/bun.lock`,
    })
  }

  // Merged before anything is written, so that its errors leave both files unchanged.
  // bun install then adds new dependencies of host packages and removes unused entries.
  const merged = mergeLockfiles(
    applyManifestToLockfile(workspace.lock, manifest),
    workspace.nestedLock,
    workspace.config.dir,
  )

  const manifestPath = path.join(root, "package.json")
  const lockPath = path.join(root, "bun.lock")
  const originals = new Map([
    [manifestPath, workspace.manifestText],
    [lockPath, await Bun.file(lockPath).text()],
  ])
  // Covers changes of package.json by lifecycle scripts of bun install as well.
  const restore = async () => {
    const failures = await restoreFiles(originals)
    if (failures.length) {
      throw new Error(
        [
          "The sync failed and could not restore the host files:",
          ...failures.map(
            ({ file, error }) => `  ${path.basename(file)}: ${getErrorMessage(error)}`,
          ),
          "Restore them before running the sync again.",
        ].join("\n"),
      )
    }
  }

  let result: SyncResult
  try {
    const manifestText = formatJson(manifest, workspace.manifestText)
    if (manifestText !== workspace.manifestText) {
      await Bun.write(manifestPath, manifestText)
    }
    options.onManifestSync?.(manifestSync)

    await Bun.write(lockPath, renderBunLock(merged))

    await runBunInstall(root, options.installArgs)

    const synced = await loadNestedWorkspace(root)
    result = {
      // The committed host lockfile alone pins the own dependencies of the host.
      ownDependencyChanges: findOwnDependencyChanges(
        workspace.lock,
        synced.lock,
        workspace.nestedLock,
        workspace.config.dir,
      ),
      check: checkNestedWorkspace(synced),
    }
  } catch (error) {
    await restore()
    throw error
  }
  if (result.ownDependencyChanges.length || !isInSync(result.check)) {
    await restore()
  }
  return result
}

/** File that `restoreFiles` could not restore. */
export interface RestoreFailure {
  file: string
  error: unknown
}

/**
 * Writes back the original texts of files whose contents differ from them and returns the files it could not restore.
 *
 * Restores each file separately, so that a failure does not keep the other files changed.
 */
export async function restoreFiles(
  originals: ReadonlyMap<string, string>,
): Promise<RestoreFailure[]> {
  const failures: RestoreFailure[] = []
  for (const [file, text] of originals) {
    try {
      const current = await Bun.file(file)
        .text()
        .catch(() => undefined)
      if (current !== text) {
        await Bun.write(file, text)
      }
    } catch (error) {
      failures.push({ file, error })
    }
  }
  return failures
}

/** Serializes JSON with the indentation and final newline of the original text. */
function formatJson(value: unknown, original: string) {
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0] ?? "  "
  return `${JSON.stringify(value, null, indent)}${original.endsWith("\n") ? "\n" : ""}`
}
