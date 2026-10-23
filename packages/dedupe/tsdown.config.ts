import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  sourcemap: true,
  // Oxc isolated declarations need no TypeScript compiler.
  dts: { generator: "oxc" },
  exports: true,
  publint: true,
  attw: {
    profile: "esm-only",
  },
})
