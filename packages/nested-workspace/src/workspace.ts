import path from "node:path"

import { renderBunLock } from "bunlock-lockfile"

import type { DependencyMismatch, PackageMismatch } from "./check"
import {
  findDirectDependencyMismatches,
  findOwnDependencyChanges,
  findTransitiveMismatches,
  findUncoveredWorkspaces,
  findWorkspaceMismatches,
} from "./check"
import type { Lockfile } from "./lockfile"
import { applyManifestToLockfile, mergeLockfiles, readLockfile, relocateLockfile } from "./lockfile"
import type { ManifestDifference, ManifestSync, PackageManifest, ResolvedConfig } from "./manifest"
import { diffManifests, readConfig, syncManifest } from "./manifest"

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
  /** Nested lockfile relocated with `relocateLockfile`. */
  nestedLock: Lockfile
}

/** Loads the root `package.json` and `bun.lock` files of the host and of the nested checkout. */
export async function loadNestedWorkspace(root: string): Promise<NestedWorkspace> {
  const manifestText = await Bun.file(path.join(root, "package.json")).text()
  const manifest = JSON.parse(manifestText) as PackageManifest
  const config = readConfig(manifest)
  const nestedRoot = path.join(root, config.dir)

  return {
    root,
    config,
    manifest,
    manifestText,
    nestedManifest: (await Bun.file(
      path.join(nestedRoot, "package.json"),
    ).json()) as PackageManifest,
    lock: await readLockfile(path.join(root, "bun.lock")),
    nestedLock: relocateLockfile(await readLockfile(path.join(nestedRoot, "bun.lock")), config.dir),
  }
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
 * Throws when the host `workspaces` patterns miss nested workspaces.
 *
 * Bun would drop such workspaces from the merged lockfile, so neither mode can sync or check them.
 */
export function assertWorkspacesCovered(workspace: NestedWorkspace): void {
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

/** Result of `syncNestedWorkspace`. */
export interface SyncResult {
  /** Own dependencies of host workspaces that the sync re-resolved; the sync failed when this is not empty. */
  ownDependencyChanges: DependencyMismatch[]
  /** Check of the synced files; the sync failed when it is not in sync. */
  check: CheckResult
}

/**
 * Syncs the host root `package.json` and `bun.lock` with the nested checkout.
 *
 * Writes the synced `package.json`, writes the merged `bun.lock`, runs `bun install`,
 * and then compares the result with the nested checkout and with the original host resolutions.
 */
export async function syncNestedWorkspace(
  root: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const workspace = await loadNestedWorkspace(root)
  assertWorkspacesCovered(workspace)
  const manifestSync = syncManifest(workspace.manifest, workspace.nestedManifest)
  const { manifest } = manifestSync

  const manifestText = formatJson(manifest, workspace.manifestText)
  if (manifestText !== workspace.manifestText) {
    await Bun.write(path.join(root, "package.json"), manifestText)
  }
  options.onManifestSync?.(manifestSync)

  // bun install then adds new dependencies of host packages and removes unused entries.
  const merged = mergeLockfiles(
    applyManifestToLockfile(workspace.lock, manifest),
    workspace.nestedLock,
    workspace.config.dir,
  )
  await Bun.write(path.join(root, "bun.lock"), renderBunLock(merged))

  await runBunInstall(root, options.installArgs)

  const synced = await loadNestedWorkspace(root)
  return {
    // The committed host lockfile alone pins the own dependencies of the host.
    ownDependencyChanges: findOwnDependencyChanges(
      workspace.lock,
      synced.lock,
      workspace.nestedLock,
      workspace.config.dir,
    ),
    check: checkNestedWorkspace(synced),
  }
}

/** Serializes JSON with the indentation and final newline of the original text. */
function formatJson(value: unknown, original: string) {
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0] ?? "  "
  return `${JSON.stringify(value, null, indent)}${original.endsWith("\n") ? "\n" : ""}`
}
