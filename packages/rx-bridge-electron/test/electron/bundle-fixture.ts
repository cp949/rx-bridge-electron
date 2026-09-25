/**
 * Electron fixture를 tsdown으로 번들하는 테스트 헬퍼.
 *
 * main은 esm, renderer는 iife(`fixtureRenderer` 전역), preload는 cjs로 만든다.
 * main·preload는 패키지 self-reference로 `dist/`를 사용하므로 test 전에 build가 필요하다.
 */
import { fileURLToPath } from "node:url";
import { build, type InlineConfig } from "tsdown";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface BundledFixture {
  readonly main: string;
  readonly preload: string;
}

/**
 * `fixtureDir`(패키지 루트 기준)의 main.ts·renderer.ts·preload.ts를
 * `node_modules/.cache/<cacheName>/`으로 번들하고 main·preload 경로를 돌려준다.
 */
export async function bundleFixture(
  fixtureDir: string,
  cacheName: string,
): Promise<BundledFixture> {
  const outDir = `node_modules/.cache/${cacheName}`;
  const run = (options: InlineConfig) =>
    build({
      config: false,
      cwd: packageRoot,
      outDir,
      clean: false,
      fixedExtension: false,
      logLevel: "warn",
      ...options,
    });
  await run({
    entry: `${fixtureDir}/main.ts`,
    format: "esm",
    clean: true,
    deps: { neverBundle: ["electron"] },
  });
  // renderer는 `<script>`로 로드되므로 peer dependency인 rxjs까지 번들에 넣는다.
  await run({
    entry: `${fixtureDir}/renderer.ts`,
    format: "iife",
    globalName: "fixtureRenderer",
    platform: "browser",
    deps: { alwaysBundle: ["rxjs"] },
  });
  // sandbox preload는 ESM을 로드하지 못한다. tsdown의 CJS 권고 경고를 끈다.
  await run({
    entry: `${fixtureDir}/preload.ts`,
    format: "cjs",
    deps: { neverBundle: ["electron"] },
    suppressWarnings: "We recommend using the ESM format",
  });
  return {
    main: `${packageRoot}${outDir}/main.js`,
    preload: `${packageRoot}${outDir}/preload.cjs`,
  };
}
