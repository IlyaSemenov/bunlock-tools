---
"bun-nested-workspace": patch
---

Support overrides that refer to a root dependency, such as `"ms": "$ms"`, and fail with an error when such a reference would change its meaning in the host.
