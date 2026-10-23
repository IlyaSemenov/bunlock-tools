# bunlock

Tools for Bun `bun.lock` files and workspaces.

- [bunlock-dedupe](packages/dedupe/README.md): finds and fixes duplicate package versions in `bun.lock`.
- [bun-nested-workspace](packages/nested-workspace/README.md): embeds a checkout of another Bun workspace repository into a Bun workspace and keeps the root `package.json` and `bun.lock` in sync with it.

## Development

Install dependencies with `bun install` from the repository root, then run the workspace checks:

```sh
bun run build
bun run types
bun run test
```
