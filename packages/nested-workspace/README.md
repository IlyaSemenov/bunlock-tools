# bun-nested-workspace

Embed a checkout of another Bun workspace repository into a subdirectory of your Bun workspace, and keep the root `package.json` and `bun.lock` of the host in sync with it.

The nested repository stays a self-contained project with its own root `package.json` and `bun.lock`.
Its root and its packages, such as `nested/apps/*` and `nested/packages/*`, become workspaces of the host.
Bun reads catalogs, overrides, patches, and trusted dependencies from the workspace root only, and resolves the whole workspace from a single lockfile.
This package carries those root fields over to the host and merges the nested lockfile into the host lockfile, so the nested packages build in the host with the same dependency versions as on their own.

## Install

The CLI runs before the host dependencies are installed, so run it with `bunx`:

```sh
bunx bun-nested-workspace
```

It requires Bun 1.4.4 or later, the first version that keeps a dependency of the host root package at its own version when the nested lockfile resolves the same package to another version.

## Setup

Add the nested directory and its packages to the host workspaces and name the nested directory in the `bun-nested-workspace` field of the host `package.json`:

```json
{
  "workspaces": ["apps/*", "nested", "nested/apps/*", "nested/packages/*"],
  "bun-nested-workspace": {
    "dir": "nested"
  }
}
```

Both modes fail when the host `workspaces` patterns miss the nested root or a nested workspace package, or when the nested root `package.json` has no `name`.

The config takes these fields:

- `dir`: the nested checkout directory, relative to the host root.
- `fields`: the root fields to sync, a subset of `catalog`, `catalogs`, `overrides`, `patchedDependencies`, and `trustedDependencies`; all of them when omitted.
- `synced`: the names of entries that came from the nested repository, maintained by the sync; commit it and do not edit it by hand.

## Nested checkout

`bun install` in the host installs the dependencies of the nested root `package.json` in the versions of the nested lockfile, so the scripts and Git hooks of the nested repository work in the checkout.
It also runs the `prepare` script of the nested root.

Change the dependencies of the nested repository by editing its `package.json` files.
Then update the nested lockfile with `bun install --lockfile-only` in the directory of any nested workspace package, and run the sync in the host:

```sh
(cd nested/packages/core && bun install --lockfile-only)
bunx bun-nested-workspace
```

A nested repository without workspace packages updates its lockfile in a separate clone.

Do not run other `bun install`, `bun add`, or `bun remove` commands in the nested directory or in its package directories:

- In the nested root, Bun runs them for the host: it writes the host lockfile and leaves the nested one stale.
- In a nested package directory, Bun installs a separate `node_modules` of the nested repository over the host install.

## Sync

Run the CLI in the host root after switching the nested checkout to another commit:

```sh
bunx bun-nested-workspace
```

The sync:

1. Merges the configured root fields of the nested `package.json` into the host `package.json`.
2. Merges the nested `bun.lock` into the host `bun.lock`.
3. Runs `bun install` with the CLI arguments, such as `--lockfile-only` or `--ignore-scripts`.
4. Fails if the install re-resolved own dependencies of host packages, or if the host does not resolve the nested packages as the nested lockfile does.

Commit `package.json` and `bun.lock` after the sync.
A failed sync restores `package.json` and `bun.lock` to their contents before the run, while `node_modules` stays as the install left it.

In a Docker build, run the sync with `--lockfile-only` in a stage that contains only the dependency files, before installing dependencies.
The dependency install runs the `prepare` script of the nested root unless it gets `--ignore-scripts`.
`bun install` also needs the patch files and the install configuration, such as `bunfig.toml` and `.npmrc`, so keep them, along with any files they reference.
A separate stage can strip the build context down to these files, so the Dockerfile does not list every workspace package:

```dockerfile
FROM oven/bun:1 AS manifests
WORKDIR /app
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock ! -name '*.patch' ! -name bunfig.toml ! -name .npmrc -delete

FROM oven/bun:1 AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN bunx bun-nested-workspace --lockfile-only
```

Exclude `node_modules` and other large directories from the build context with `.dockerignore`.

### Root fields

- `catalog` and `catalogs` each stay where the host defines them; a field the host lacks goes next to the other catalog field, or into `workspaces`.
  An array `workspaces` field becomes an object when a catalog needs it.
- `overrides` are merged by their keys, so a group such as `"micromatch": { "picomatch": "^2.3.2" }` replaces the host group with the same key as a whole.
  The sync requires each `bun.lock` to be up to date with the overrides of its `package.json`.
- `trustedDependencies` are merged by package name.
- `resolutions` on either side is an error while `overrides` are synced: Bun ignores `resolutions` once `overrides` is defined, so move its entries to `overrides`.
- `trustedDependencies` stays in the host `package.json`, even empty, when either side defines it.
  An explicit list replaces the default trusted list of Bun, so when only one side defines the field, the packages of the other side lose the default list; list the ones whose lifecycle scripts they need.
  The sync warns when it adds the field to the host.
- `patchedDependencies` paths are rewritten through the nested directory, such as `nested/patches/exceljs@4.4.0.patch`.
  Bun warns on every install that it ignores `patchedDependencies` of the nested root package; keep them there, because the host applies the synced copies.

A nested entry replaces a host entry with the same key, while the other host entries stay.
The sync lists the host entries it replaced.
A host entry equal to the nested one stays the host's own, so it survives when the nested repository drops it.
An entry that came from the nested repository and is no longer there is removed; for patches, these are the patches inside the nested directory.
A package version patched by both the host and the nested repository is an error.

### Lockfile

The nested lockfile entries replace the host entries, so the nested packages keep their versions.
When a replaced entry no longer satisfies a dependency of a host package, the host package keeps its previous resolution, and the nested packages keep theirs.
When neither satisfies the range, which Bun lockfiles occasionally contain, the dependency gets the highest satisfying version recorded in either lockfile.
Ranges are checked as `bun install` applies them: an override replaces the declared range, and an `npm:` alias requires the package it names.
`bun install` then resolves new dependencies of host packages and drops unused entries.

After the install, the sync compares the direct dependencies of host packages with the original host lockfile.
A dependency may only change to the version that the nested lockfile hoists to its top level, and only within the host range.
Any other change means either that the host lockfile did not pin the host dependencies, for example after an edit of a host `package.json` without `bun install`, or that the lockfile cannot record the host version next to the nested one.
The latter happens to a host workspace other than the root without a name, because Bun records workspace-specific versions under the workspace name; name the workspace or align its range with the nested version.

Only `bun.lock` with `lockfileVersion` 1, 2, or 3 is supported, because the lockfile format is internal to Bun.

## Check

```sh
bunx bun-nested-workspace --check
```

The check writes nothing, does not run `bun install`, and exits with code 1 when the host files lag behind the nested checkout.
It reads the root `package.json` and `bun.lock` of the host and of the nested checkout only, so it relies on the nested `bun.lock` being up to date with the nested packages.
Verify that in the CI of the nested repository with `bun install --lockfile-only` followed by `git diff --exit-code bun.lock`: `bun install --frozen-lockfile` misses some changes, such as a narrowed range that the locked version still satisfies.
Use it in a non-blocking CI job that signals when a sync commit is due.

It reports:

- synced root fields of the host `package.json` that differ from the result of a sync;
- nested workspaces whose `bun.lock` entries differ from the nested lockfile, which covers changed dependency declarations and added or removed packages;
- direct dependencies of nested packages that the host resolves to other versions than the nested lockfile;
- transitive dependencies of nested packages that the host resolves to other versions than the nested lockfile.

The transitive check walks the dependency edges from the nested packages through both lockfiles at once and compares the resolved version and integrity of each edge.
A different hoisting layout of the same versions is therefore not a difference.

Limitations:

- Peer dependencies are not walked.
- Edges that the nested lockfile itself resolves outside their range are skipped, because the sync repairs them in the host.
- The check does not verify that the host lockfile matches the host packages; `bun install --lockfile-only` followed by `git diff --exit-code bun.lock` does.
- The check does not predict whether a sync would re-resolve own dependencies of host packages; only the sync detects it after `bun install`.

## API

The package exports the functions the CLI is built from:

```ts
import {
  checkNestedWorkspace,
  isInSync,
  loadNestedWorkspace,
  syncNestedWorkspace,
} from "bun-nested-workspace"

const check = checkNestedWorkspace(await loadNestedWorkspace(process.cwd()))
if (!isInSync(check)) {
  const result = await syncNestedWorkspace(process.cwd(), { installArgs: ["--lockfile-only"] })
  if (result.ownDependencyChanges.length || !isInSync(result.check)) {
    throw new Error("The sync changed host dependencies or did not keep the nested resolutions")
  }
}
```

`syncNestedWorkspace` writes the files and runs `bun install` before it checks the result.
When `bun install` fails or the result shows differences, it restores both files before it throws or returns, and throws an error saying so when it cannot restore them.
Its `onManifestSync` option receives the replaced host entries and whether the sync added `trustedDependencies`, as soon as `package.json` is written and even when `bun install` then fails.

Lower-level functions work on parsed files without touching the disk: `syncManifest`, `diffManifests`, `parseLockfile`, `relocateLockfile`, `applyManifestToLockfile`, `mergeLockfiles`, and the `find*` checks.
