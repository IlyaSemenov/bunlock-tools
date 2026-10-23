---
"bun-nested-workspace": minor
---

Warn when the sync adds `trustedDependencies` to the host, which disables the default trusted list of Bun. `syncNestedWorkspace` reports the replaced host entries through the new `onManifestSync` option instead of `SyncResult.overridden`, even when `bun install` fails.
