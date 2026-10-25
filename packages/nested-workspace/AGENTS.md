# bun-nested-workspace Agent Guide

## Overview

CLI and API that embed a checkout of another Bun workspace repository into a subdirectory of a host Bun workspace and keep the host root `package.json` and `bun.lock` in sync with it.

## Scope

- Keep integration and package-boundary tests in `tests/`.
- Name compile-only type tests `*.type-test.ts`.
- Treat the CLI flags, the `bun-nested-workspace` config field, and the `synced` lists it maintains as public contracts.
- Keep consumer-specific conventions out of the package.

## Lockfile

- Parse `bun.lock` with `parseLockfile`, which accepts only `supportedLockfileVersions`; add a version only after checking its format.
- Evaluate ranges with `Bun.semver`, as `bun install` does, except for override selection, which goes through `bunlock-lockfile`.
- Compare resolutions through dependency edges, not lockfile keys: `bun install` may hoist the same versions differently.
- Compare package entries by their string elements; the metadata object differs between Bun versions.
- Write the merged lockfile with `renderBunLock`; `bun install` then rewrites it.
- Give the merged lockfile the higher `lockfileVersion` of the two, or 1 when `needsLockfileVersion1` holds for one of its entries.
- Before writing, check that the host `bun.lock` records the overrides of the host `package.json`, and the nested `bun.lock` those of the nested `package.json` when `overrides` are synced; skip a side whose `package.json` has no `overrides` field.

## Changesets

- Before 1.0, use `minor` for breaking changes; starting with 1.0, use `major` and remove this rule.

## Checks

- Run the `build` script before tests in `tests/`: they import the package through its exports.
