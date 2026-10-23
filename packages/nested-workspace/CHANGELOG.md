# bun-nested-workspace

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
