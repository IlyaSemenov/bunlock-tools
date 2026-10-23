---
"bunlock-dedupe": patch
"bun-nested-workspace": patch
---

Report overrides scoped to a parent package or a version selector, which Bun 1.4 writes to `bun.lock`, as unsupported with a clear error; `bunlock-dedupe` previously crashed on them.
