import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/protocol/index.ts",
    "src/contract/index.ts",
    "src/renderer/index.ts",
    "src/main/index.ts",
    "src/preload/index.ts",
    "src/testing/index.ts",
  ],
  // package.json `exports`가 `.js`를 가리킨다. platform node 기본값인 `.mjs`를 쓰지 않는다.
  fixedExtension: false,
  format: ["esm"],
  sourcemap: true,
});
