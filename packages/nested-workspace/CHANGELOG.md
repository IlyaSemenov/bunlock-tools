# bun-nested-workspace

## 0.2.0

### Minor Changes

- e7576f0: Warn when the sync adds `trustedDependencies` to the host, which disables the default trusted list of Bun. `syncNestedWorkspace` reports the replaced host entries through the new `onManifestSync` option instead of `SyncResult.overridden`, even when `bun install` fails.
- e7576f0: Reject `resolutions` in the host or nested `package.json` while `overrides` are synced, because Bun ignores `resolutions` once `overrides` is defined.

## 0.1.0

### Minor Changes

- e97e48f: Initial beta release.
