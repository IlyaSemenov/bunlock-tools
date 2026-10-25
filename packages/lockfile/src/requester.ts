import semver from "semver"

import { type BunLockFile, parseResolvedSpec } from "./parse"

/**
 * Package that declares a dependency, as Bun identifies it to apply overrides scoped to a parent package.
 *
 * Without a requester, only rules without a parent apply.
 */
export type OverrideRequester = {
  /** Package name from the package spec, or the workspace name. */
  name?: string
  /** Version that a parent selector `name@range` is matched against; absent for a source without one. */
  version?: string
}

/**
 * Return the override requester for a package entry with the given spec.
 *
 * As in Bun, only a registry package and a workspace other than the root have a version;
 * a git, tarball, or local package has none, so a parent selector with a range never matches it.
 */
export function packageOverrideRequester(
  lock: Pick<BunLockFile, "workspaces">,
  spec: string,
): OverrideRequester {
  const resolved = parseResolvedSpec(spec)
  if (!resolved) return {}
  if (resolved.version.startsWith("workspace:")) {
    const workspace = Object.entries(lock.workspaces ?? {}).find(
      ([workspacePath, { name }]) => workspacePath !== "" && name === resolved.name,
    )
    return { name: resolved.name, version: workspace?.[1].version }
  }
  return { name: resolved.name, version: semver.valid(resolved.version) ?? undefined }
}

/** Return the override requester for the workspace at the given path; the root workspace has no version. */
export function workspaceOverrideRequester(
  lock: Pick<BunLockFile, "workspaces">,
  workspacePath: string,
): OverrideRequester {
  const workspace = lock.workspaces?.[workspacePath]
  return {
    name: workspace?.name,
    version: workspacePath === "" ? undefined : workspace?.version,
  }
}
