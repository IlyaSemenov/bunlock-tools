# bunlock-dedupe Agent Guide

## Overview

CLI that analyzes, deduplicates, and updates dependencies in `bun.lock` files.

## Scope

- Keep fixture-driven integration cases in `test/fixtures/`.
- Treat CLI flags and documented output as public contracts.

## Architecture

- Keep analysis and rewriting independent of report rendering and CLI I/O.
- Keep update discovery, safety validation, and application as separate responsibilities.
- Route registry and Bun-cache I/O through shared access interfaces.

## Lockfile invariants

- Preserve declared dependency ranges for display when an override replaces them.
- When simulating removal of a nested entry, exclude it from lookup and preserve ancestor-before-root precedence.
- Use lock keys and requester node IDs for identity and safety decisions; use `requestPath` only for display.
- Dedupe rewrites operate per package version, not per lock entry: a version is rewritten only when every inbound request accepts the target.
- For dedupe and version updates, never write a lockfile in which a dependency range resolves to an incompatible version; `--update --fix` must validate the simulated final lockfile and skip offending updates.
- Do not copy context-specific package tuple metadata such as `bundled` when reusing an entry as a rewrite template.
- Run unreachable-entry pruning even when the current pass performs no dedupe rewrite, so an already-deduplicated lockfile can still be cleaned up.
- Track dedupe rewrites and unreachable-entry removals separately in result counters and CLI summaries.
- Sort dependency maps created from registry metadata by package name before rendering.
- During repair, restore declarations for the locked versions without changing package versions or performing deduplication.
- In `--repair` mode, verify published version metadata against the existing archive integrity before restoring dependency maps and optional-peer declarations.
- Keep patched and non-registry entries unchanged during repair.
- Skip a package's repair if its restored declarations require a dependency absent from its lockfile context, including non-semver requests; report the missing dependencies in skipped entries.
- Report incompatible existing resolutions exposed by restored declarations in both preview and fix output.

## Documentation

- Keep README content limited to CLI flags, workflow, and how to read the report.

## Tests

- Prefer a fixture for user-visible report or rewrite regressions; use a unit test only when the behavior is an isolated algorithm that the fixture pipeline does not expose clearly.
- Treat `test/fixtures/<name>/` directories as auto-discovered by `test/fixtures.test.ts`.
- Generate expected fixture files by running the real pipeline and reviewing its output; do not hand-write them.
- When a behavior change trivializes a fixture's output, adapt the fixture so its named scenario stays observable instead of only rewriting the expected report.

## Reproductions

- Treat supplied lockfiles as read-only and run `--fix` only on a copy.
- Save large CLI reports to a temporary file and extract only the relevant package block for inspection.
- In a `used by` line, the path ends at the requester, the group heading names the requested package, and the suffix is the requester's declared range.
