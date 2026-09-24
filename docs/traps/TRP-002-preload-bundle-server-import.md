# TRP-002 preload 번들이 server 모듈과 `rxjs`를 끌어오는 값 import

- 상태: RESOLVED
- 적용 조건(과거): `src/main/electron-adapter.ts` 또는 preload가 import하는 모듈(`src/preload/*`,
  `src/protocol/*`)에 다른 `src/main/*` 모듈의 **값** import를 추가할 때.

## 오해하기 쉬운 신호

`pnpm check-types`, `pnpm lint`, 단위 테스트(`test/main/*`)는 모두 통과한다. 실패는
`test/electron/bridge.electron.test.ts`에서만 나고, 메시지가 원인을 가리키지 않는다:

- `page.evaluate: TypeError: Cannot read properties of undefined (reading 'connect')`
- `AssertionError: expected { ready: false, …(1) } to deeply equal { ready: true }`

빌드 캐시나 환경 문제처럼 보이고 TRP-001 flake로 오인하기 쉽다. 이 경우 여러 테스트가 함께 실패하고
재실행해도 계속 실패한다.

## 원인

`src/preload/expose-bridge.ts`는 `ELECTRON_BRIDGE_CHANNELS` 때문에 `src/main/electron-adapter.ts`를
import한다. adapter가 `create-bridge-server.ts`처럼 `rxjs`를 쓰는 모듈을 값으로 import하면 tsup이 그 모듈을
preload chunk에 넣고, `dist/preload`가 `rxjs`를 require한다. sandbox preload는 `rxjs`를 require할 수 없어
로드에 실패하고 `rxBridge`가 노출되지 않는다.

RD-007(운영 진단)에서 adapter가 `create-bridge-server.ts`의 `recordAdapterRejection` Symbol을 값으로
import해 발생했다. Symbol을 런타임 import가 없는 `src/main/diagnostics.ts`로 옮겨 해소했다(fceedf3).

## 해소 경위 (RD-019 DELTA-01)

근본 원인은 preload(`src/preload/expose-bridge.ts`)가 채널 정의(`ELECTRON_BRIDGE_CHANNELS`·
`DEFAULT_ELECTRON_BRIDGE_NAMESPACE`·`ElectronBridgeChannels`)를 얻으려고 `src/main/electron-adapter.ts`를
값으로 import해야 했다는 구조 자체다. 이 채널 정의를 런타임 import가 없는 leaf 모듈
`src/protocol/electron-channels.ts`로 옮기고, preload는 거기서 직접 import한다. `src/main/electron-adapter.ts`는
이제 같은 모듈에서 import해 재사용하고 세 심볼을 re-export만 한다(`/main`의 공개 표면은 그대로 유지).
이제 preload는 `src/main/*`을 값으로 import할 경로가 없다.

## 탐지/회피

- eslint `@typescript-eslint/no-restricted-imports`(루트 `eslint.config.js`)가
  `src/{preload,protocol,renderer}/**`에서 `../main/*`·`../../main/*`의 **값** import를 에러로 잡는다
  (`import type`은 허용). 이 guard가 재발을 구조적으로 막는 주 탐지 수단이다.
- `pnpm build` 뒤 preload 번들과 그 chunk에 `rxjs`가 없는지 확인한다(보조 탐지):

  ```sh
  cd packages/rx-bridge-electron
  grep -c rxjs dist/preload/index.js $(sed -n 's#.*"\.\./\(chunk-[A-Z0-9]*\.js\)".*#dist/\1#p' dist/preload/index.js)
  ```

  모든 파일이 `0`이어야 한다.
