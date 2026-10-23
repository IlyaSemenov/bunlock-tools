import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  sourcemap: true,
  exports: true,
  // Emit workspace declarations together so the bundled bunlock-lockfile types are available.
  dts: { eager: true },
})
