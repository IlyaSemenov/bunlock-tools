# bunlock-tools Workspace Agent Guide

## Overview

Tools that read and rewrite Bun `bun.lock` files.

Read the affected package's README completely before changing its CLI behavior, public API, supported runtimes, output, or user documentation.
Each workspace package's `AGENTS.md` adds the conventions specific to that package.

Extend this guide only with stable, non-obvious conventions, architecture, contracts, workflows, and gotchas.
Do not catalog files or restate information evident from their names and locations.

## Scope

- Keep production code in each package's `src/`.
- Keep focused module tests beside their source as `*.test.ts`.
- Keep package `src/index.ts` files limited to explicit public exports.
- Treat published package `package.json` exports and supported runtimes as public contracts.

## Tooling

- Build every published package with the same tsdown setup, generating declarations with Oxc.
- Typecheck with `bun check`.
- Declare development tools shared by several packages in the root `workspaces.catalog` and reference them as `catalog:`.
- Keep `dependencies` of published packages as plain ranges: `changeset publish` publishes through npm, which does not rewrite `catalog:` or `workspace:` specifiers.

## Architecture

- Implement lockfile parsing, rendering, and dependency lookup once in the private `bunlock-lockfile` package.
- Use its shared resolver for normal dependency lookup.
- Bundle `bunlock-lockfile` into each published package: list it in `devDependencies`, and keep published JavaScript and declarations free of imports from it.
- Declare the runtime imports of `bunlock-lockfile` in the `dependencies` of each published package that bundles it.
- Keep `bunlock-lockfile` independent of dedupe, repair, registry access, and CLI I/O.
- Keep `bunlock-lockfile` free of Bun-specific APIs: `bunlock-dedupe` runs on Node.

## Documentation

- Write README and CLI text for users who do not know the implementation.
- Add JSDoc to every exported declaration and to internal helpers whose contract, inputs, output, or failure behavior is not obvious.
- Add inline comments beside every non-obvious invariant, algorithmic choice, safety constraint, and intentionally limited behavior.
- Update nearby JSDoc and inline comments whenever the documented code changes, and remove comments that no longer apply.
- Do not narrate self-evident syntax or restate what a name already communicates.
- Do not document obvious or implied defaults.
- Describe a default only when readers need it to make a decision or avoid surprising behavior.
- Use One Sentence Per Line for connected prose.
- Keep semantically connected explanations as prose paragraphs.
- Use lists for separate assertions instead of presenting them as prose paragraphs.

## Tests

- Add a `describe` block where the file gives a reason for it: several APIs or behaviors in one file, or a fixture that belongs to some cases but not all.
- Name such a block after what it covers and keep its fixtures inside it.
- Distinguish several same-kind values by role rather than by order.
- When values differ only by order, number them with digits instead of ordinal words.
- Keep tests deterministic so a failure repeats on every run.
- Generate random inputs from an explicit seed and print the seed in failure messages so the failing input can be replayed.

## Changesets

- Add one `.changeset/*.md` file for each independently releasable user-visible change.
- Include every affected published package and its SemVer bump in the changeset frontmatter; a change in `bunlock-lockfile` affects every published package whose behavior it changes.
- Do not add changesets for internal refactors, maintenance, tests, or documentation changes that do not require a package release.
- Choose the SemVer bump from the public contract: `patch` for backward-compatible fixes, `minor` for backward-compatible functionality, and `major` for breaking changes.
- Create `.changeset/<unique-name>.md` with this format, adding a frontmatter entry for every affected published package:

```markdown
---
"<package-name>": patch
---

Describe the user-visible change.
```

- Write one or two concise sentences for users describing the observable change or new capability.
  Avoid implementation details and rationale.
- Do not edit package versions or `CHANGELOG.md` files by hand, and do not run `changeset version` or `changeset publish`; the release workflow consumes pending changesets.

## Checks

- Run package checks from that package's directory or use root scripts to check every workspace package.
- Build and publish each package from its own directory.
- Run the `types` script when public types, shared interfaces, or TypeScript configuration change.
- Run the `test` script when behavior changes.
- Run the `build` script when package exports, declarations, supported runtimes, or the bundling of `bunlock-lockfile` change.
- Treat `bun run lint` and `bun run check` as mutating commands because they run oxlint and oxfmt with auto-fixes.
