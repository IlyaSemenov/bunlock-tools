import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  // Oxc isolated declarations need no TypeScript compiler.
  dts: { generator: "oxc" },
  exports: {
    bin: true,
    exclude: ["cli"],
  },
  publint: true,
  attw: {
    profile: "esm-only",
  },
})
