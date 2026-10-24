---
"bun-nested-workspace": minor
---

Require Bun 1.4.4 or later.
Earlier versions fail the sync when the host root package and the nested lockfile resolve a dependency to different versions.
