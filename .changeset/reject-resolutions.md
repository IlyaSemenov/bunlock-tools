---
"bun-nested-workspace": minor
---

Reject `resolutions` in the host or nested `package.json` while `overrides` are synced, because Bun ignores `resolutions` once `overrides` is defined.
