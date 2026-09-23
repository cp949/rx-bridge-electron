import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/protocol/index.ts",
    "src/contract/index.ts",
    "src/renderer/index.ts",
    "src/main/index.ts",
    "src/preload/index.ts",
  ],
  format: ["esm"],
  sourcemap: true,
});
