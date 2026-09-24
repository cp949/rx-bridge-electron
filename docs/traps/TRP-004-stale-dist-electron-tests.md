# TRP-004 `test/electron/*.electron.test.ts`가 stale `dist/`를 조용히 재사용

- 상태: ACTIVE
- 적용 조건: `packages/rx-bridge-electron`의 `src/main`·`src/preload`·`src/renderer`를 고친 뒤,
  `pnpm --filter @cp949/rx-bridge-electron build`를 다시 돌리지 않은 채 패키지 로컬에서
  `pnpm test`·`pnpm check-types`·`vitest run test/electron`을 직접 실행할 때. 패키지 `verify`와 루트
  `pnpm check-types`·`pnpm test`·`pnpm verify`는 build를 먼저 하므로 해당하지 않는다.

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
- 패키지 `verify`는 `pnpm build && pnpm check-types && pnpm test` 순서라 이 트랩을 피한다. 루트
  turbo는 `@cp949/rx-bridge-electron#check-types`·`#test`에 `dependsOn: ["build"]`를 선언한다. 그래서
  "verify는 통과했는데 직접 돌린 test는 실패한다"는 차이가 생길 수 있다 — 직접 실행 쪽이 stale `dist/`다.

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
- 저장소 루트의 `pnpm check-types`/`pnpm test`/`pnpm verify`(turbo 경유)나 패키지 `verify`를 쓴다 —
  둘 다 `build`를 먼저 실행한다.
- 에러 메시지가 fixture 코드의 타입 문제처럼 보이는데 방금 손댄 게 `src/`뿐이라면, 먼저 `dist/` 재빌드를
  의심한다.
