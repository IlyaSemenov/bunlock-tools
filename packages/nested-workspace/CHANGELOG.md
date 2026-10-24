# bun-nested-workspace

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
