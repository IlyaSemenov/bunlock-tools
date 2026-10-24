#!/usr/bin/env bun
// Syncs the host root package.json and bun.lock with the nested checkout, or checks them with --check.
// Arguments other than --check are passed to bun install.

import { getErrorMessage } from "./errors"
import type { ManifestDifference, ManifestSync, OverriddenEntry } from "./manifest"
import type { CheckResult } from "./workspace"
import {
  BunInstallError,
  checkNestedWorkspace,
  isInSync,
  loadNestedWorkspace,
  syncNestedWorkspace,
} from "./workspace"

const usage = `Usage:
  bun-nested-workspace [bun install options]  Sync package.json and bun.lock, then run bun install
  bun-nested-workspace --check                Exit with 1 if package.json or bun.lock lag behind the nested checkout

Configure the nested directory in the "bun-nested-workspace" field of the host package.json.`

/** Runs the CLI with the given arguments in the given host root and returns the exit code. */
async function runCli(args: readonly string[], root: string = process.cwd()): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage)
    return 0
  }

  try {
    if (args.includes("--check")) {
      const extra = args.filter(arg => arg !== "--check")
      if (extra.length) {
        console.error(`--check takes no other options, got ${extra.join(" ")}\n\n${usage}`)
        return 1
      }
      return await runCheck(root)
    }
    return await runSync(root, args)
  } catch (error) {
    if (error instanceof BunInstallError) {
      return error.exitCode
    }
    console.error(getErrorMessage(error))
    return 1
  }
}

async function runCheck(root: string) {
  const workspace = await loadNestedWorkspace(root)
  const result = checkNestedWorkspace(workspace)
  if (isInSync(result)) {
    console.log(`package.json and bun.lock are in sync with ${workspace.config.dir}`)
    return 0
  }

  console.error(
    [
      `package.json and bun.lock lag behind ${workspace.config.dir}:`,
      ...formatCheckResult(result),
      "Run bun-nested-workspace without --check and commit package.json and bun.lock.",
    ].join("\n"),
  )
  return 1
}

async function runSync(root: string, installArgs: readonly string[]) {
  const { ownDependencyChanges, check } = await syncNestedWorkspace(root, {
    installArgs,
    onManifestSync: printManifestSync,
  })

  let exitCode = 0
  if (ownDependencyChanges.length) {
    console.error(
      [
        "The sync changed own dependencies of host packages.",
        "Either the host bun.lock did not pin them: restore bun.lock, run bun install, commit bun.lock, and sync again.",
        "Or the nested lockfile resolves them outside the host range: align the host range with the nested version.",
        ...ownDependencyChanges.map(({ workspace, dependency, expected, actual }) =>
          formatChange(`${workspace} > ${dependency}`, expected, actual),
        ),
      ].join("\n"),
    )
    exitCode = 1
  }
  if (!isInSync(check)) {
    console.error(
      ["bun install did not keep the nested resolutions:", ...formatCheckResult(check)].join("\n"),
    )
    exitCode = 1
  }
  return exitCode
}

function printManifestSync({ overridden, addedTrustedDependencies }: ManifestSync) {
  if (overridden.length) {
    console.log(
      ["Nested entries replaced host entries:", ...overridden.map(formatOverridden)].join("\n"),
    )
  }
  if (addedTrustedDependencies) {
    console.warn(
      [
        "The sync added trustedDependencies to the host package.json.",
        "Bun no longer applies its default trusted list, so host dependencies that relied on it no longer run their lifecycle scripts.",
        "Add the ones the host needs to trustedDependencies.",
      ].join("\n"),
    )
  }
}

/** Formats the differences of a failed check as indented lines grouped by kind. */
function formatCheckResult(result: CheckResult): string[] {
  const section = (title: string, lines: string[]) =>
    lines.length ? [`  ${title}:`, ...lines.map(line => `  ${line}`)] : []

  return [
    ...section("package.json", result.manifest.map(formatDifference)),
    ...section(
      "bun.lock workspaces",
      result.workspaces.map(workspacePath => `  ${workspacePath}`),
    ),
    ...section(
      "direct dependencies",
      result.directDependencies.map(({ workspace, dependency, expected, actual }) =>
        formatChange(`${workspace} > ${dependency}`, actual, expected),
      ),
    ),
    ...section(
      "transitive dependencies",
      result.transitiveDependencies.map(({ path, expected, actual }) =>
        formatChange(path.join(" > "), actual, expected),
      ),
    ),
  ]
}

function formatDifference({ path, expected, actual }: ManifestDifference) {
  const format = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value))
  return formatChange(path, format(actual), format(expected))
}

function formatOverridden({ field, name, hostValue, nestedValue }: OverriddenEntry) {
  return formatChange(`${field}.${name}`, JSON.stringify(hostValue), JSON.stringify(nestedValue))
}

/**
 * Formats a value change as an indented line, with a dash for a missing value.
 *
 * Lockfile entries of the same version can still differ in their registry or integrity.
 */
function formatChange(label: string, from: string | undefined, to: string | undefined) {
  return from === to
    ? `  ${label}: ${from} (registry or integrity differs)`
    : `  ${label}: ${from ?? "—"} → ${to ?? "—"}`
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)))
}
