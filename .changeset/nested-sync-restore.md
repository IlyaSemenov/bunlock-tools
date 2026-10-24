---
"bun-nested-workspace": minor
---

A failed sync restores the host `package.json` and `bun.lock`, so the next sync still detects changed versions of host dependencies; `syncNestedWorkspace` restores them too instead of leaving them for inspection. When the nested `bun.lock` lags behind the nested `package.json` files, the sync says so and prints the command that updates it.
