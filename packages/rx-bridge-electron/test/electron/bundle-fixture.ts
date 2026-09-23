/**
 * Electron fixture를 tsup으로 번들하는 테스트 헬퍼.
 *
 * main은 esm, renderer는 iife(`fixtureRenderer` 전역), preload는 cjs로 만든다.
 * main·preload는 패키지 self-reference로 `dist/`를 사용하므로 test 전에 build가 필요하다.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsupExecutable = fileURLToPath(
  new URL("../../node_modules/.bin/tsup", import.meta.url),
);

export interface BundledFixture {
  readonly main: string;
  readonly preload: string;
}

/**
 * `fixtureDir`(패키지 루트 기준)의 main.ts·renderer.ts·preload.ts를
 * `node_modules/.cache/<cacheName>/`으로 번들하고 main·preload 경로를 돌려준다.
 */
export function bundleFixture(
  fixtureDir: string,
  cacheName: string,
): BundledFixture {
  const outDir = `node_modules/.cache/${cacheName}`;
  const run = (args: readonly string[]) =>
    execFileSync(tsupExecutable, [...args], { cwd: packageRoot });
  run([
    `${fixtureDir}/main.ts`,
    "--format",
    "esm",
    "--out-dir",
    outDir,
    "--external",
    "electron",
  ]);
  run([
    `${fixtureDir}/renderer.ts`,
    "--format",
    "iife",
    "--global-name",
    "fixtureRenderer",
    "--out-dir",
    outDir,
    "--no-clean",
  ]);
  run([
    `${fixtureDir}/preload.ts`,
    "--format",
    "cjs",
    "--out-dir",
    outDir,
    "--no-clean",
    "--external",
    "electron",
  ]);
  return {
    main: `${packageRoot}${outDir}/main.js`,
    preload: `${packageRoot}${outDir}/preload.cjs`,
  };
}
