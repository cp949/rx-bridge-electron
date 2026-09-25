# 연결 설정 인자를 선택화하고 고정 기본값을 둔다: namespace/role `"default"`, globalName `"rxBridge"`, electron는 호출 시점 namespace import

- 관련: RD-014

> **개정 (RD-019, `ROADMAP.md#RD-019`)**: 아래 "namespace 기본값은 `"default"`" 결정(:15)이 정의하던 채널 이름·기본 namespace 상수(`ELECTRON_BRIDGE_CHANNELS`·`DEFAULT_ELECTRON_BRIDGE_NAMESPACE`·`ElectronBridgeChannels`)는 이제 `src/protocol/electron-channels.ts`에 있다. `src/main/electron-adapter.ts`는 이 모듈에서 값으로 import해 재사용하고, `src/main/index.ts`는 세 심볼을 그대로 재수출만 한다 — 채널 형식(`rx-bridge-electron:v1:${namespace}:*`), 기본값(`"default"`), `/main`의 공개 이름은 바뀌지 않았다. `./protocol`(공개 `@cp949/rx-bridge-electron/protocol`) export에는 넣지 않았다 — protocol의 공개 표면은 transport 중립(Electron IPC를 모르는 소비자도 쓰는 `parse*`·`withEnvelope`·`PROTOCOL_VERSION`)으로 남기고, 이 채널 상수는 Electron 어댑터 전용이기 때문이다. eslint `@typescript-eslint/no-restricted-imports`(루트 `eslint.config.js`)가 `src/{preload,protocol,renderer}/**`에서 `src/main/*`의 값 import를 에러로 잡는다(`import type`은 허용) — 채널 상수를 얻으려고 preload가 다시 `src/main/*`를 값으로 import하는 구조([TRP-002](../traps/TRP-002-preload-bundle-server-import.md))가 재발하지 않게 lint로 막는다.

## 문제

`bindElectronBridge`·`exposeBridgeInMainWorld`·`createRendererApi`는 지금 `ipcMain`·`contextBridge`·`ipcRenderer`·`namespace`·`role`·`transport`를 전부 호출자가 명시해야 한다. README hello-world 기준으로 연결 설정 코드가 Main·preload·Renderer 세 지점에 걸쳐 필요 이상으로 길다. 목표는 이 연결 설정 코드를 import를 제외하고 Main 3줄·preload 2줄·Renderer 2줄 이하로 줄이는 것이다. 이 문서는 그 축약이 기존 계약(채널 형식, 서버·어댑터 분리, 보안 경계)을 건드리지 않고 인자 선택화만으로 이루어지도록 기본값과 해석 순서를 고정한다.

## 결정: 기존 함수의 인자를 선택화한다. 새 API·병행 API는 만들지 않는다

`bindElectronBridge`·`exposeBridgeInMainWorld`·`createRendererApi`는 그대로 두고 일부 인자를 optional로 바꾼다. 축약형과 명시형이 같은 함수의 두 호출 방식이 되게 해서, 기존에 모든 인자를 명시하던 호출은 코드 변경 없이 동일하게 동작한다. 별도의 `*Simple`/`*WithDefaults` 변형이나 옵션 객체를 받는 overload는 두지 않는다 — 진입점이 늘어나면 문서화·타입 추론·유지보수 비용이 배로 든다.

## 결정: `namespace` 기본값은 `"default"`, `role` 기본값은 `"default"`, `globalName` 기본값은 `"rxBridge"`

- `namespace`: Main(`bindElectronBridge`)과 preload(`exposeBridgeInMainWorld`) 양쪽에서 생략 시 같은 문자열 상수 `"default"`를 쓴다. 두 지점이 각자 다른 기본값을 두면 한쪽만 생략했을 때 채널이 어긋나는 조용한 실패가 생긴다. 채널 형식 `rx-bridge-electron:v1:${namespace}:*`는 바뀌지 않으므로, 기본 namespace의 채널은 `rx-bridge-electron:v1:default:*`가 된다.
- `role`: `attach(webContents, role?)`에서 생략 시 `"default"`. `allowedOrigins`와 달리 생략해도 검사 자체가 사라지지 않는다 — role은 `authorize`의 `context.windowRole` 입력일 뿐이고, 인가 판단은 `authorize`가 한다. 역할로 인가를 나누지 않는 앱은 생략하고, 나누는 앱은 창마다 명시한다(데모의 `main`/`monitor`).
- `globalName`: `exposeBridgeInMainWorld`가 `contextBridge.exposeInMainWorld`에 쓰는 이름이자 `createRendererApi`가 fallback으로 읽는 전역 프로퍼티 이름이다. 기존에 이미 쓰던 값 `"rxBridge"`를 그대로 기본값으로 삼는다 — 새 이름을 도입하면 기존 데모·문서와 불일치가 생긴다.

## 결정: electron 모듈은 `import * as electron from "electron"` 네임스페이스 import로 참조하고, 호출 시점에 해석한다. 주입값이 항상 우선한다

`bindElectronBridge`는 `ipcMain`을, `exposeBridgeInMainWorld`는 `contextBridge`·`ipcRenderer`를 생략 가능하게 하면서 내부적으로 `electron` 모듈에서 읽어야 한다. 이때 `import { ipcMain } from "electron"`처럼 named import를 쓰지 않는다 — Node.js(Electron 밖, 예: 유닛 테스트 실행 환경)에서 `electron` 패키지는 실행 파일 경로 문자열 하나만 export하므로, named import는 모듈 그래프 해석이 아니라 **ESM 링크 단계**에서 `SyntaxError`를 낸다. 이 오류는 해당 코드 경로를 타지 않아도, 즉 값을 실제로 쓰지 않아도 import 구문만으로 발생한다.

대신 `import * as electron from "electron"`으로 모듈 네임스페이스 객체를 가져오고, 필요한 시점(함수 호출 시점)에 `electron.ipcMain`처럼 프로퍼티로 접근한다. 네임스페이스 import는 Node에서도 문자열 하나를 담은 객체로 링크되므로 `SyntaxError`가 나지 않고, 실제 Electron 프로세스에서는 정상적인 모듈 객체가 된다. 주입 인자(`options.ipcMain` 등)가 존재하면 `electron.*`보다 항상 우선한다 — 테스트가 mock을 주입해도 실제 `electron` 모듈 해석을 시도하지 않게 하기 위해서다. 주입값도 없고 `electron.*`도 얻을 수 없으면(비-Electron 런타임에서 기본값 경로를 탄 경우) 명확한 오류로 실패한다.

## 결정: `createRendererApi<B>(options?)`는 `transport` 생략 시 `globalThis.rxBridge`를 읽는다

> **개정 (RD-028, [ADR 0022](0022-renderer-diagnostics.md))**: 아래 "위치 인자 `transport` 하나만 받고 옵션 객체 overload는 두지 않는다"는 결정은 뒤집혔다 — `createRendererApi`는 이제 위치 인자 대신 `CreateRendererApiOptions`(`{ transport?, diagnostics? }`) 옵션 객체 하나를 받는다. 이 문서가 고정한 "`transport` 생략 시 `globalThis.rxBridge`를 읽는다"는 동작 자체는 그대로다.

`transport`는 여전히 `BridgeTransport | undefined`만 받는다 — 생략하면 `globalThis.rxBridge`를 읽어 `BridgeTransport`로 쓴다. `rxBridge`는 `exposeBridgeInMainWorld`의 `globalName` 기본값과 같은 문자열이다 — 두 기본값이 어긋나면 축약형 Renderer 코드가 항상 실패하므로 같은 상수(`DEFAULT_BRIDGE_GLOBAL_NAME`)를 공유한다. `globalName`을 바꾼 소비자는 `createRendererApi`에 transport를 직접 만들어 넘긴다(이 경로에서만 `declare global`이 필요하다). 전역에 값이 없으면 "어느 전역을 찾다가 실패했는지"를 담은 명확한 오류로 실패한다 — `undefined`를 그대로 전달해 나중에 알기 어려운 오류로 이어지지 않게 한다.

## 결정: hello-world에서 `pagehide` dispose 등록을 뺀다. `dispose`는 SPA teardown 용도로 문서화한다

지금까지 hello-world 예제는 Renderer 쪽에서 `window.addEventListener("pagehide", () => api.dispose())`를 등록했다. 이 등록을 hello-world 연결 설정에서 제거한다. 근거:

- [ADR 0002](0002-renderer-document-session-ownership.md)에 따라 브리지 자원의 소유자는 BrowserWindow가 아니라 `webContents`의 현재 main-frame 문서 세션이다. navigation·reload·renderer 종료·detach 시 Main이 그 세션을 이미 retire하고 진행 중 작업을 중단한다.
- [ADR 0006](0006-shutdown-contract.md)이 고정한 Main 쪽 종료 경로(`DocumentSessions`의 lifecycle 이벤트에 따른 세션 정리)는 Renderer가 `dispose()`를 호출하는지와 무관하게 동작한다. 즉 `pagehide`에서 `dispose()`를 부르지 않아도 창을 닫거나 reload하면 Main 자원은 회수된다.
- fixture·multi-window 테스트는 이미 `dispose`/`pagehide`를 등록하지 않은 채로 이 회수를 검증하고 있다(RD-008 reload 시나리오, soak). hello-world만 별도로 `pagehide` dispose를 등록해 온 것은 실제로 필요하지 않은 코드였다.

`dispose()` 자체를 제거하거나 의미를 바꾸지는 않는다. 용도를 다음과 같이 재정의해 문서화한다: **`api.dispose()`는 브리지가 살아있는 동안 Renderer 쪽에서 스스로 정리를 끝내고 싶을 때(SPA 라우팅으로 화면을 벗어나며 그 화면의 구독을 끊는 경우 등) 쓰는 명시적 teardown이다.** 창·문서가 사라지는 경로의 자원 회수는 dispose 호출 여부와 무관하게 Main이 책임진다. 두 경로는 서로 대체 수단이 아니라 각자 다른 시점(문서 생존 중 vs. 문서 종료)을 다룬다.

## 결정: `allowedOrigins`는 계속 필수, `role`은 선택(기본 `"default"`)

`allowedOrigins`는 origin 검증이라는 보안 경계 자체를 이루므로 기본값을 주지 않는다 — 생략 가능하게 하면 소비자가 실수로 모든 origin을 허용하는 효과를 내기 쉽다. `role`은 `authorize`에 전달되는 입력이므로 생략하면 `"default"`로 전달될 뿐 검사를 우회하지 않는다. 역할 기반 `authorize`를 쓰는 앱은 `"default"`를 허용하지 않도록 작성하고 창마다 role을 명시한다.

## 결정: `createBridgeServer`와 `bindElectronBridge`의 분리는 유지한다

두 함수를 하나로 합치는 통합은 이번 축약 범위 밖이다. `createBridgeServer`는 Electron에 의존하지 않는 프로토콜 서버를, `bindElectronBridge`는 그 서버를 Electron IPC 채널에 연결하는 어댑터를 만든다. 이 경계를 유지해야 서버 쪽 단위 테스트가 Electron 없이 계속 가능하다.

## 범위 밖

- `createRendererApi`의 `{ globalName }` 옵션 객체 overload. transport 인자는 `BridgeTransport | undefined`만 받는다 — 다른 이름의 전역을 읽고 싶은 소비자는 transport를 직접 만들어 넘긴다.
- hello-world 이외의 자동 `pagehide` dispose 등록. 이 문서는 자동 등록을 추가하는 게 아니라 hello-world에서 불필요한 수동 등록을 빼는 것이다.
- Renderer Proxy를 동결 객체 트리로 교체하는 것(`.scratch/renderer-proxy-frozen-tree`).
- 와이어 형식·채널 형식·handshake 프로토콜 변경.

## 적용 범위

demo·Electron fixture·README를 이 문서의 축약형으로 옮긴다. demo는 기존 역할(role) 2개 구성을 유지한다. 패키지 단위 테스트와 multi-window fixture는 명시 주입 경로(`ipcMain`·`contextBridge`·`ipcRenderer`·`namespace`·`role`·`transport`를 전부 넘기는 호출)를 계속 검증해, 축약형 도입이 기존 명시 호출의 동작이나 타입을 바꾸지 않았음을 보장한다. "dispose 없이 창을 닫거나 reload해도 Main이 세션·구독·RPC 슬롯을 회수한다"는 이 문서가 만드는 새 보장이 아니라 ADR 0002·0006이 이미 고정한 동작이며, RD-014는 이를 완료 조건에 포함해 회귀가 없는지 다시 확인한다.

## 기각한 대안

- **`electron` named import**: Node 실행 환경에서 ESM 링크 단계 `SyntaxError`를 내므로 채택하지 않는다.
- **`createRendererApi(transport?, options?)`처럼 두 번째 옵션 인자 추가**: transport 인자 하나만 받는 현재 시그니처를 유지해 API 표면을 넓히지 않는다.
- **`bindElectronBridge`/`exposeBridgeInMainWorld`를 옵션 객체 대신 여러 위치 인자로 변경**: 기존 명시 호출의 타입과 동작을 바꾸게 되어 "기존 전체 명시 호출은 코드 변경 없이 동일 동작"이라는 전제를 깬다.
