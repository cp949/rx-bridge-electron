# TRP-004 `test/electron/*.electron.test.ts`가 stale `dist/`를 조용히 재사용

- 상태: ACTIVE
- 적용 조건: `packages/rx-bridge-electron`의 `src/main`·`src/preload`·`src/renderer`를 고친 뒤,
  `pnpm --filter @cp949/rx-bridge-electron build`를 다시 돌리지 않은 채
  `test/electron/*.electron.test.ts`(또는 그 패키지의 `verify` 스크립트를 직접)를 실행할 때.

## 오해하기 쉬운 신호

- `pnpm --filter @cp949/rx-bridge-electron test`(non-electron 단위 테스트)는 `src/`를 직접 보므로
  통과한다. 단위 test 기준으로는 `*.electron.test.ts`만 영향받는다.
- `check-types`도 stale `dist/`로 통과할 수 있다. `tsconfig.json`이 `test/**/*.ts`를 포함하고,
  fixture(`test/electron/multi-window/main.ts` 등)는 패키지 이름으로 import해 `dist/*.d.ts`를 본다.
  공개 타입을 바꾼 뒤 build 전에 돌린 `check-types`는 fixture의 옛 시그니처 사용을 잡지 못하고
  exit 0이다(예: `authorize` 인자를 바꿨을 때 build 후에야 `TS2345: Argument of type
'BridgeOperation' is not assignable to parameter of type 'string'.`).
- 실패가 tsup dts 빌드 에러(예: `Argument of type '{...}' is not assignable to parameter of type
'BindElectronBridgeOptions'`)로 나타나, 방금 만든 fixture 코드가 잘못된 것처럼 보인다. 실제로는
  `dist/`가 이전 함수 시그니처를 그대로 들고 있는 것이다.
- 이 패키지의 `verify` 스크립트(`pnpm check-types && pnpm test && pnpm build`, `packages/rx-bridge-electron/package.json`)는 `build`가 `test` _뒤에_ 있어서, 이 스크립트를 그대로 실행하면
  stale dist인 채로 `test`(electron 테스트 포함)를 돌리게 된다. 저장소 루트의 `pnpm verify`/`pnpm test`는
  `turbo.json`이 `@cp949/rx-bridge-electron#test`에 `dependsOn: ["build"]`를 선언해 이 문제를 피하므로,
  이 트랩은 패키지 로컬 `pnpm --filter @cp949/rx-bridge-electron verify`(또는 `test`) 직접 실행에서만
  나타난다.

## 원인

패키지가 `package.json`의 `exports`로 `dist/*`만 노출하고(`src` 직접 import 경로 없음), Electron fixture
(`test/electron/fixture/*.ts`, `test/electron/multi-window/*.ts`)는 워크스페이스 패키지 이름
(`@cp949/rx-bridge-electron/main` 등)으로 import한다. `bundleFixture`가 tsup으로 이 fixture를 번들할 때
그 `dist`를 그대로 링크하므로, `src`를 고친 직후 `dist`를 재빌드하지 않으면 fixture 번들이 옛 `dist`를
링크한다.

## 탐지/회피

- `src/main`·`src/preload`·`src/renderer`를 고친 뒤 `*.electron.test.ts`를 돌리기 전에
  `pnpm --filter @cp949/rx-bridge-electron build`를 먼저 실행한다.
- 공개 타입을 바꿨으면 `build` 뒤에 `check-types`를 한 번 더 실행한다.
- 저장소 루트에서는 `pnpm test`/`pnpm verify`(turbo 경유)를 쓴다 — `turbo.json`의
  `dependsOn: ["build"]`가 이 패키지의 `test` 실행 전에 `build`를 강제한다.
- 에러 메시지가 fixture 코드의 타입 문제처럼 보이는데 방금 손댄 게 `src/`뿐이라면, 먼저 `dist/` 재빌드를
  의심한다.
- 패키지 로컬 `verify` 스크립트(`check-types && test && build`)를 직접 실행하지 않는다 — 순서상
  `build`가 `test`보다 뒤에 있어 이 트랩을 그대로 재현한다.
