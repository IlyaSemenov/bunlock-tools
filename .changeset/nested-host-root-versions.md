---
"bun-nested-workspace": patch
---

Fix the sync failing when the host root package and the nested repository depend on different versions of the same package, such as a newer `eslint` in the host root than in the nested root.
