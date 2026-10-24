---
"bun-nested-workspace": patch
---

Fix the sync breaking the host `bun.lock` when the nested `bun.lock` was created before the nested root `package.json` had a name.
