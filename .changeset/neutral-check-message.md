---
"bun-nested-workspace": patch
---

`--check` no longer assumes the host files lag behind the nested checkout: they may have been synced with another revision of it.
