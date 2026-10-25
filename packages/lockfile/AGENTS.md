# bunlock-lockfile Agent Guide

## Lockfile invariants

- Read package tuple metadata from the object slot and preserve its position: registry packages store it third, while git packages store it second.
- Treat `bun.lock` overrides as the effective dependency ranges, apply them as Bun 1.4.4 does, and pass the requesting package to every override lookup.
- Convert `package.json` overrides to `bun.lock` overrides as Bun 1.4.4 does, and throw on the rules that Bun skips with a warning instead of skipping them; values that Bun cannot parse as a dependency spec are not detected.
- Treat prerelease compatibility with default semver range semantics; a prerelease satisfies only comparator sets that explicitly opt into a prerelease with the same major, minor, and patch tuple.
- Treat an optional peer as a reachability edge only when the resolved entry satisfies its effective range; keep unknown non-semver compatibility conservative.
- For a package requester, normal dependency lookup order is exact `requester/dependency`, closest ancestor-provided nested entry, then root `dependency`.
- For context-free lookup, use the root entry first and accept a nested entry only when it is the unique candidate.
- Preserve package key order during rendering.
