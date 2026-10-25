---
"bun-nested-workspace": minor
---

Support overrides scoped to a parent package or a version range, such as `"micromatch": { "picomatch": "^2.3.2" }` or `"picomatch@^2"`, and lockfiles with `lockfileVersion` 3, instead of exiting with an error.
The sync fails before writing anything when a `bun.lock` is not up to date with the overrides of its `package.json`.
A merged `bun.lock` that keeps a package Bun reads only at `lockfileVersion` 1, such as a tarball outside the npm registry without an integrity hash, is written with version 1, so Bun no longer discards it and resolves every dependency again.
