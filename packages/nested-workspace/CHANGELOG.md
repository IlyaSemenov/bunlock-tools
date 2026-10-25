# bun-nested-workspace

## 0.5.1

### Patch Changes

- e0e7c48: `--check` no longer assumes the host files lag behind the nested checkout: they may have been synced with another revision of it.

## 0.5.0

### Minor Changes

- 106922e: Support overrides scoped to a parent package or a version range, such as `"micromatch": { "picomatch": "^2.3.2" }` or `"picomatch@^2"`, and lockfiles with `lockfileVersion` 3, instead of exiting with an error.
  The sync fails before writing anything when a `bun.lock` is not up to date with the overrides of its `package.json`.
  A merged `bun.lock` that keeps a package Bun reads only at `lockfileVersion` 1, such as a tarball outside the npm registry without an integrity hash, is written with version 1, so Bun no longer discards it and resolves every dependency again.

## 0.4.0

### Minor Changes

- 2843ca7: A failed sync restores the host `package.json` and `bun.lock`, so the next sync still detects changed versions of host dependencies; `syncNestedWorkspace` restores them too instead of leaving them for inspection. When the nested `bun.lock` lags behind the nested `package.json` files, the sync says so and prints the command that updates it.

## 0.3.2

### Patch Changes

- eeb8ca6: Fix the sync failing when the host root package and the nested repository depend on different versions of the same package, such as a newer `eslint` in the host root than in the nested root.

## 0.3.1

### Patch Changes

- abf7a76: Fix the sync breaking the host `bun.lock` when the nested `bun.lock` was created before the nested root `package.json` had a name.

## 0.3.0

### Minor Changes

- c38a412: Require Bun 1.4.4 or later.
  Earlier versions fail the sync when the host root package and the nested lockfile resolve a dependency to different versions.
- 36c17e8: Install the dependencies of the nested root `package.json`, so the scripts and Git hooks of the nested repository work in the checkout.
  The host `workspaces` must now include the nested directory itself, such as `"nested"`.

### Patch Changes

- 74a2082: Support overrides that refer to a root dependency, such as `"ms": "$ms"`, and fail with an error when such a reference would change its meaning in the host.
- d9e7384: Apply overrides to `npm:` alias dependencies, such as `"dbg": "npm:debug@^4"`, the way `bun install` does.

## 0.2.1

### Patch Changes

- 21ec168: Report overrides scoped to a parent package or a version selector, which Bun 1.4 writes to `bun.lock`, as unsupported with a clear error; `bunlock-dedupe` previously crashed on them.

## 0.2.0

### Minor Changes

- e7576f0: Warn when the sync adds `trustedDependencies` to the host, which disables the default trusted list of Bun. `syncNestedWorkspace` reports the replaced host entries through the new `onManifestSync` option instead of `SyncResult.overridden`, even when `bun install` fails.
- e7576f0: Reject `resolutions` in the host or nested `package.json` while `overrides` are synced, because Bun ignores `resolutions` once `overrides` is defined.

## 0.1.0

### Minor Changes

- e97e48f: Initial beta release.
