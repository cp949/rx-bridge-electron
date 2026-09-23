# rx-bridge-electron

신뢰하는 로컬 UI를 위한 타입 지정 및 스키마 검증 기반 Electron IPC 라이브러리입니다. 애플리케이션 수준에서 요청/응답 방식의 **RPC**, 현재값을 제공하는 **State**, 재생하지 않는 **Event** 스트림을 제공합니다. 스트림 API는 RxJS만 사용합니다.

## 진입점과 프로세스 경계

| 진입점                               | 실행 위치     | 책임                                                    |
| ------------------------------------ | ------------- | ------------------------------------------------------- |
| `@cp949/rx-bridge-electron/contract` | 모든 프로세스 | 도메인 설명자, 스키마, 계약 조합, 추론된 Renderer 타입  |
| `@cp949/rx-bridge-electron/main`     | Main          | 핸들러 연결, 권한 확인, 검증, 세션, 진단 정보           |
| `@cp949/rx-bridge-electron/preload`  | preload       | `contextBridge`로 노출하는 고정 Electron 채널 어댑터    |
| `@cp949/rx-bridge-electron/renderer` | renderer      | 비동기 Proxy, RPC 클라이언트, `RemoteState`, RxJS Event |

계약은 특정 프로세스에 종속되지 않는 데이터입니다. 핸들러, Electron 객체, 자격 증명, Node API, 함수, `Observable`, `Subject`는 preload 경계를 넘지 않습니다. Renderer 애플리케이션 코드는 동결된 `BridgeTransport`만 받으며 `ipcRenderer`, `send`, `invoke`, 채널 이름 또는 원시 Electron 이벤트에는 접근할 수 없습니다.

`rxjs`와 `electron`은 peer dependency입니다. Electron 런타임은 애플리케이션이 소유하며, 대상 Electron 버전에 맞게 preload를 번들링하고 준비해야 합니다.

## 설치 / Installation

```sh
npm install @cp949/rx-bridge-electron rxjs electron
```

GitHub repository: <https://github.com/cp949/rx-bridge-electron>

Install the package and its peer dependencies with npm. The source repository is <https://github.com/cp949/rx-bridge-electron>.

## 도메인 전체 예제

```ts
// bridge/contract.ts — 공유 선언만 둡니다.
import {
  composeContracts,
  defineDomain,
  rpc,
  state,
  type InferBridge,
  type Schema,
} from "@cp949/rx-bridge-electron/contract";

const noInput: Schema<undefined> = {
  parse: (value) => {
    if (value !== undefined) throw new TypeError("No input expected");
    return undefined;
  },
};
const connection: Schema<{ readonly connected: boolean }> = {
  parse: (value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as { connected?: unknown }).connected !== "boolean"
    ) {
      throw new TypeError("Invalid connection");
    }
    return { connected: (value as { connected: boolean }).connected };
  },
};

export const device = defineDomain("device", {
  rpc: { connect: rpc({ input: noInput, output: connection }) },
  state: { connection: state(connection) },
});
export const appContract = composeContracts(device);
export type AppBridge = InferBridge<typeof appContract>;
```

```ts
// Main — 권한이 필요한 구현은 계약과 분리합니다.
import { BehaviorSubject } from "rxjs";
import {
  createBridgeServer,
  currentValueSource,
  implementDomain,
} from "@cp949/rx-bridge-electron/main";
import { appContract, device } from "./bridge/contract.js";

const connection = new BehaviorSubject({ connected: false });
const server = createBridgeServer(
  appContract,
  [
    implementDomain(device, {
      rpc: { connect: () => ({ connected: true }) },
      state: { connection: currentValueSource(connection) },
    }),
  ],
  {
    authorize: (context, operation) =>
      context.windowRole === "main" || !operation.startsWith("rpc:"),
  },
);
```

```ts
// Preload — exposeBridgeInMainWorld()를 호출한 다음 Renderer를 비동기로 초기화합니다.
import { contextBridge, ipcRenderer } from "electron";
import { exposeBridgeInMainWorld } from "@cp949/rx-bridge-electron/preload";
exposeBridgeInMainWorld({
  contextBridge,
  ipcRenderer,
  namespace: "app",
  globalName: "appBridge",
});

// Renderer
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import type { BridgeTransport } from "@cp949/rx-bridge-electron/renderer";
import type { AppBridge } from "./bridge/contract.js";
declare global {
  interface Window {
    readonly appBridge: BridgeTransport;
  }
}
const api = await createRendererApi<AppBridge>(window.appBridge);
await api.device.rpc.connect();
api.device.state.connection.subscribe(console.log);
// 진행 중 RPC를 취소하고 활성 구독을 정리합니다. api[Symbol.dispose]()와 같은 함수입니다.
window.addEventListener("pagehide", () => api.dispose(), { once: true });
```

`bindElectronBridge({ ipcMain, server, namespace, allowedOrigins })`로 서버를 연결하고, 허용한 각 최상위 창에 `attach(webContents, role)`을 호출합니다. Main을 종료하기 전에 연결을 해제해야 합니다. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, 고정 preload, 탐색 및 창 생성 제한, 명시적 신뢰 origin 허용 목록을 사용하세요. `dispose()` 뒤 서버와 bind는 다시 쓸 수 없습니다 — 되돌릴 수 없는 종료이므로, 다시 연결하려면 새 `createBridgeServer`와 `bindElectronBridge`를 만드세요.

## 런타임 동작

`createRendererApi()`는 Proxy를 반환하기 전에 handshake를 수행합니다. Main 서버는 직렬화 가능한 manifest를 제공하고, Proxy는 선언된 경로만 노출합니다. `then` 속성 때문에 Proxy가 Promise처럼 동작하지 않습니다. 정식 operation 경로는 Renderer가 제공한 객체 경로가 아니라 범주를 포함합니다(`rpc:device/connect`, `state:device/connection`). 공개 호출 형태는 도메인 아래에 종류 계층을 두는 `api.<domain path>.rpc|state|event.<operation>`입니다(`api.device.rpc.connect()`, `api.device.state.connection`, `api.device.event.data`). 도메인에 정의가 없는 종류는 노출하지 않습니다. operation 이름은 `/`를 포함할 수 없고, 묶음은 도메인 경로(`defineDomain("device/serial", ...)` → `api.device.serial.rpc.open()`)로 표현합니다. 도메인 경로의 segment로 `rpc`, `state`, `event`를 쓸 수 없습니다(근거: [ADR 0007](../../docs/adr/0007-hierarchical-renderer-api.md)).

루트 API는 `api.dispose()`와 `api[Symbol.dispose]`를 같은 함수로 노출하며, 호출은 되돌릴 수 없는 최종 종료입니다(근거: [ADR 0006](../../docs/adr/0006-shutdown-contract.md)). 진행 중인 RPC는 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 즉시 reject되고, 이미 Main에 전송된 요청에는 best-effort cancel을 보냅니다. 활성 State/Event 구독은 `unsubscribe` 전송 후 `complete()`됩니다(`error`가 아닙니다). 종료 후 호출한 RPC·subscribe는 전송 없이 같은 `CANCELLED` 오류로 끝납니다. 반복 `dispose()` 호출은 no-op입니다. `dispose`는 루트 도메인 이름으로 예약되어 있어 첫 segment가 `dispose`인 도메인 이름(`defineDomain("dispose", ...)`, `defineDomain("dispose/x", ...)`)은 거부됩니다. 하위 segment나 operation 이름으로는 계속 쓸 수 있습니다(예: `device/dispose` 도메인, `api.device.rpc.dispose`).

각 RPC는 structured clone이 가능한 입력값 하나를 받습니다. `AbortSignal`과 `timeoutMs`는 별도 `CallOptions`로 전달합니다. 취소, timeout, 응답 중 하나만 최종 결과가 됩니다. 원격 실패는 `FORBIDDEN`, `INVALID_ARGUMENT`, `CANCELLED`, `DEADLINE_EXCEEDED` 같은 프로토콜 코드를 가진 `RemoteError` 값으로 전달됩니다.

`RemoteState<T>`는 읽기 전용 Observable이며 `.snapshot`을 제공합니다.

- `uninitialized`: 값이 없고 활성 원격 구독도 없습니다.
- `connecting`: 첫 로컬 구독자가 원격 구독을 열었습니다.
- `current`: Main의 현재값을 받았습니다. 구독자에게 알리기 전에 snapshot에 반영됩니다.
- `stale`: 값이 존재한 상태에서 마지막 구독자가 구독을 해제했습니다. 오래된 데이터는 이후 generation의 새 값으로 재생하지 않습니다.

같은 generation이 활성인 동안 늦게 합류한 로컬 구독자는 `subscribe()` 호출 안에서 현재값을 동기로 1회 받습니다. `undefined`도 유효한 현재값으로 전달됩니다. 아직 값을 받지 못한 `connecting` 상태(첫 로컬 구독자가 원격 구독을 열었지만 첫 값이 도착하기 전)에서 늦게 구독하면 즉시 아무 값도 받지 않고 첫 값을 기다립니다.

하나의 Renderer 문서 안에서는 여러 State/Event 구독자가 로컬 source를 공유합니다. Main의 소유 범위는 연결된 `webContents`와 문서 세션입니다. reload, 탐색, 완료, 오류, 마지막 구독 해제, 문서 파괴 시 관련 자원을 정리합니다. State는 현재값을 우선 전달합니다. Event는 재생하지 않으며 `subscribed` 확인 이후 순서를 보장하고 최대 한 번 전달합니다. Event buffer는 용량과 overflow 정책(`error`, `drop-oldest`, `drop-newest`)을 명시해야 합니다.

## 검증, 한도, 범위 밖 기능

Main은 핸들러를 호출하기 전에 RPC 입력을, 전송하기 전에 출력을, 전달하기 전에 스트림 값을 검증합니다. v1 payload는 `undefined`, `null`, 원시 값, 배열, 일반 객체 트리만 허용합니다. 순환 참조, 함수, symbol, 사용자 정의 prototype, typed array, transferable을 거부합니다. 기본 한도는 깊이 32, 항목 10,000개, 문자열당 UTF-8 1,000,000 byte입니다.

입력과 출력의 검증 실패는 서로 다른 오류 코드로 응답합니다. 요청 envelope나 RPC 입력이 이 규칙을 어기면 `INVALID_ARGUMENT`로 거부됩니다. 반면 RPC 출력과 스트림(State/Event) 값의 검증 실패는 `INTERNAL`입니다 — handler나 출력 스키마가 만든 값도 전송 전에 같은 규칙으로 다시 검증하며, 출력 스키마가 변환한 결과도 예외 없이 재검사 대상입니다. handler가 선언되지 않은 예외를 던지거나 출력 스키마 자체가 예외를 던져도(선언된 오류 코드를 가진 예외라도) `INTERNAL`로 응답하고, 선언된 도메인 에러라도 `message`나 `details`가 위 한도를 넘으면 `INTERNAL`로 대체됩니다. 검증 실패 시점에 요청이 이미 취소된 상태라면 `CANCELLED`가 우선합니다.

진단 정보에는 RPC 완료·취소와 스트림 수명주기 정보를 기록할 수 있지만, 자격 증명이나 원시 payload는 넣지 않습니다. 대용량 바이너리 전송과 지속적인 고속 스트림은 현재 범위에 포함되지 않습니다. 향후 이 기능이 필요하면 이 API에서 원시 IPC를 노출하지 말고 별도의 MessagePort 어댑터 뒤에 구현합니다.
