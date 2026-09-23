import { defineConfig } from "vitest/config";

// 장시간 반복 검증. 기본 `vitest run`에서 제외하고 `pnpm test:soak`로만 실행한다.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.soak.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
