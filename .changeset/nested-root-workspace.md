---
"bun-nested-workspace": minor
---

Install the dependencies of the nested root `package.json`, so the scripts and Git hooks of the nested repository work in the checkout.
The host `workspaces` must now include the nested directory itself, such as `"nested"`.
