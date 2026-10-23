# bun-nested-workspace

Embed a checkout of another Bun workspace repository into a subdirectory of your Bun workspace, and keep the root `package.json` and `bun.lock` of the host in sync with it.

The nested repository stays a self-contained project with its own root `package.json` and `bun.lock`.
Its packages, such as `nested/apps/*` and `nested/packages/*`, become workspaces of the host, while its root does not.
Bun reads catalogs, overrides, patches, and trusted dependencies from the workspace root only, and resolves the whole workspace from a single lockfile.
This package carries those root fields over to the host and merges the nested lockfile into the host lockfile, so the nested packages build in the host with the same dependency versions as on their own.

## Install

The CLI runs before the host dependencies are installed, so run it with `bunx`:

```sh
bunx bun-nested-workspace
```

It requires Bun 1.2.19 or later, the first version that resolves `catalog:` dependencies from both catalog locations.

## Setup

Add the nested packages to the host workspaces and name the nested directory in the `bun-nested-workspace` field of the host `package.json`:

```json
{
  "workspaces": ["apps/*", "nested/apps/*", "nested/packages/*"],
  "bun-nested-workspace": {
    "dir": "nested"
  }
}
```

Both modes fail when the host `workspaces` patterns miss a workspace package of the nested repository.

The config takes these fields:

- `dir`: the nested checkout directory, relative to the host root.
- `fields`: the root fields to sync, a subset of `catalog`, `catalogs`, `overrides`, `patchedDependencies`, and `trustedDependencies`; all of them when omitted.
- `synced`: the names of entries that came from the nested repository, maintained by the sync; commit it and do not edit it by hand.

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

In a Docker build, run the sync with `--lockfile-only` in a stage that contains only the dependency files, before installing dependencies:

```dockerfile
COPY package.json bun.lock ./
COPY nested/package.json nested/bun.lock nested/
COPY nested/packages/core/package.json nested/packages/core/
RUN bunx bun-nested-workspace --lockfile-only
```

### Root fields

- `catalog` and `catalogs` each stay where the host defines them; a field the host lacks goes next to the other catalog field, or into `workspaces`.
  An array `workspaces` field becomes an object when a catalog needs it.
- `overrides` and `trustedDependencies` are merged by package name.
- `trustedDependencies` stays in the host `package.json`, even empty, when either side defines it.
  An explicit list replaces the default trusted list of Bun, so when only one side defines the field, the packages of the other side lose the default list; list the ones whose lifecycle scripts they need.
- `patchedDependencies` paths are rewritten through the nested directory, such as `nested/patches/exceljs@4.4.0.patch`.

A nested entry replaces a host entry with the same name, while the other host entries stay.
The sync lists the host entries it replaced.
A host entry equal to the nested one stays the host's own, so it survives when the nested repository drops it.
An entry that came from the nested repository and is no longer there is removed; for patches, these are the patches inside the nested directory.
A package version patched by both the host and the nested repository is an error.

Bun warns when a nested patch targets a package version that the host does not install, such as a patched tool used only by the nested root.

### Lockfile

The nested lockfile entries replace the host entries, so the nested packages keep their versions.
When a replaced entry no longer satisfies a dependency of a host package, the host package keeps its previous resolution as a nested lockfile entry.
When neither satisfies the range, which Bun lockfiles occasionally contain, the dependency gets the highest satisfying version recorded in either lockfile.
Ranges are checked as `bun install` applies them: an override replaces the declared range, and an `npm:` alias requires the package it names.
`bun install` then resolves new dependencies of host packages and drops unused entries.

After the install, the sync compares the direct dependencies of host packages with the original host lockfile.
A dependency may only change to the version that the nested lockfile resolves at its root, and only within the host range.
Any other change means either that the host lockfile did not pin the host dependencies, for example after an edit of a host `package.json` without `bun install`, or that the lockfile cannot record the host version next to the nested one.
The latter happens to a host workspace without a name, because Bun records workspace-specific versions under the workspace name; name the workspace or align its range with the nested version.

Only `bun.lock` with `lockfileVersion` 1 or 2 is supported, because the lockfile format is internal to Bun.

## Check

```sh
bunx bun-nested-workspace --check
```

The check writes nothing, does not run `bun install`, and exits with code 1 when the host files lag behind the nested checkout.
It reads the root `package.json` and `bun.lock` of the host and of the nested checkout only, so it relies on the nested `bun.lock` being up to date with the nested packages; `bun install --frozen-lockfile` in the nested directory verifies that.
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
- The check does not verify that the host lockfile matches the host packages; `bun install --frozen-lockfile` does.
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

`syncNestedWorkspace` writes the files and runs `bun install` before it checks the result, so a failed sync leaves the written files for inspection.

Lower-level functions work on parsed files without touching the disk: `syncManifest`, `diffManifests`, `parseLockfile`, `relocateLockfile`, `applyManifestToLockfile`, `mergeLockfiles`, and the `find*` checks.
