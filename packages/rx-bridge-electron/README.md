# rx-bridge-electron

신뢰하는 로컬 UI를 위한 타입 지정 및 스키마 검증 기반 Electron IPC 라이브러리입니다. 애플리케이션 수준에서 요청/응답 방식의 **RPC**, 현재값을 제공하는 **State**, 재생하지 않는 **Event** 스트림을 제공합니다. 스트림 API는 RxJS만 사용합니다.

## 진입점과 프로세스 경계

| 진입점                               | 실행 위치     | 책임                                                                           |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `@cp949/rx-bridge-electron/contract` | 모든 프로세스 | 계약 타입에서 파생하는 타입(`BridgeApi`/`BridgeImpl`/`SchemasFor`/`ErrorsFor`) |
| `@cp949/rx-bridge-electron/main`     | Main          | 서버 생성, 핸들러 연결, 권한 확인, 검증, 세션, 진단 정보                       |
| `@cp949/rx-bridge-electron/preload`  | preload       | `contextBridge`로 노출하는 고정 Electron 채널 어댑터                           |
| `@cp949/rx-bridge-electron/renderer` | renderer      | 동결 API 객체, RPC 클라이언트, `RemoteState`, RxJS Event, 진단 sink            |

계약은 런타임 값이 아니라 순수 TS 타입입니다. 핸들러, Electron 객체, 자격 증명, Node API, 함수, `Observable`, `Subject`는 preload 경계를 넘지 않습니다. Renderer 애플리케이션 코드는 동결된 `BridgeTransport`만 받으며 `ipcRenderer`, `send`, `invoke`, 채널 이름 또는 원시 Electron 이벤트에는 접근할 수 없습니다.

`rxjs`와 `electron`은 peer dependency입니다. Electron 런타임은 애플리케이션이 소유하며, 대상 Electron 버전에 맞게 preload를 번들링하고 준비해야 합니다.

## 설치 / Installation

```sh
npm install @cp949/rx-bridge-electron rxjs electron
```

GitHub repository: <https://github.com/cp949/rx-bridge-electron>

Install the package and its peer dependencies with npm. The source repository is <https://github.com/cp949/rx-bridge-electron>.

## Hello world (RPC 1개, State 1개)

계약은 rpc·state·event 카테고리를 갖는 도메인들의 중첩 객체 타입입니다. 스키마도 zod도 필요 없습니다.

```ts
// bridge/contract.ts — 공유 선언만 둡니다.
export type AppBridge = {
  device: {
    rpc: { connect(): { readonly connected: boolean } };
    state: { connection: { readonly connected: boolean } };
  };
};
```

Main은 두 부분입니다: 도메인 서버를 만드는 코드(아래 첫 블록)와, 그 서버를 Electron IPC에 연결하는 배선 코드(아래 두 번째 블록)입니다.

```ts
// Main — 도메인 서버
import { BehaviorSubject } from "rxjs";
import {
  createBridgeServer,
  currentValueSource,
} from "@cp949/rx-bridge-electron/main";
import type { BridgeImpl } from "@cp949/rx-bridge-electron/contract";
import type { AppBridge } from "./bridge/contract.js";

const connection = new BehaviorSubject({ connected: false });
const impl: BridgeImpl<AppBridge> = {
  device: {
    rpc: { connect: () => ({ connected: true }) },
    state: { connection: currentValueSource(connection) },
  },
};
const server = createBridgeServer(impl, {
  authorize: (context, operation) =>
    context.windowRole === "main" || operation.category !== "rpc",
});
```

```ts
// Main — Electron IPC에 연결합니다. app은 electron의 app, win은 이미 만든 BrowserWindow입니다.
import { bindElectronBridge } from "@cp949/rx-bridge-electron/main";

const bridge = bindElectronBridge({ server, allowedOrigins: ["file://"] });
bridge.attach(win.webContents, "main"); // 위 authorize가 읽는 context.windowRole
app.once("before-quit", () => bridge.dispose());
```

```ts
// Preload
import { exposeBridgeInMainWorld } from "@cp949/rx-bridge-electron/preload";

exposeBridgeInMainWorld();
```

```ts
// Renderer — 브리지에 연결합니다.
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import type { AppBridge } from "./bridge/contract.js";

const api = await createRendererApi<AppBridge>();
```

```ts
// Renderer — 사용 예(배선이 아닙니다)
await api.device.rpc.connect();
api.device.state.connection.subscribe(console.log);
```

`impl: BridgeImpl<AppBridge>`는 계약이 선언한 모든 도메인·모든 operation에 대응하는 handler/source를 가진 일반 객체입니다. 계약과 구현이 어긋나면(누락, 초과, handler·소스 형태 오류) 컴파일 타임에 실패합니다 — `AppBridge`와 `impl`이 같은 타입에서 파생하므로 별도의 런타임 재검증이 필요 없습니다(근거: [ADR 0012](../../docs/adr/0012-lightweight-type-contract.md)). manifest는 `impl`의 키에서 만들므로, 타입을 우회해(`as any`) 빠뜨린 operation은 애초에 Renderer에 노출되지 않습니다. impl 형태 검사(handler가 함수인지, state가 `getValue`를 갖는지 등)는 타입을 우회한 값을 상대로 한 방어선으로 유지되며, 위반 시 서버 생성이 `TypeError`로 실패합니다.

`authorize(context, operation)`는 등록된 operation에 대한 RPC·구독 요청마다 호출되는 인가 콜백입니다(생략하면 전부 허용). `operation`은 wire key를 미리 분해한 동결 객체 `BridgeOperation`이므로 문자열을 직접 자를 필요가 없습니다.

| 필드        | 예(`rpc:admin/users/remove`) | 설명                                        |
| ----------- | ---------------------------- | ------------------------------------------- |
| `key`       | `"rpc:admin/users/remove"`   | wire key 전체. 특정 operation 비교에 씁니다 |
| `category`  | `"rpc"`                      | `"rpc" \| "state" \| "event"`               |
| `domain`    | `["admin", "users"]`         | 도메인 segment 배열                         |
| `operation` | `"remove"`                   | operation 이름                              |

`BridgeOperation`·`OperationCategory` 타입은 `@cp949/rx-bridge-electron/main`에서 가져옵니다(근거: [ADR 0018](../../docs/adr/0018-authorize-structured-operation.md)).

`bindElectronBridge({ ipcMain?, server, namespace?, allowedOrigins })`로 서버를 연결하고, 허용한 각 최상위 창에 `attach(webContents, role?)`을 호출합니다. `ipcMain`·`namespace`·`role`은 생략 가능하며 기본값은 아래 표를 참고하세요. `allowedOrigins`는 origin 검증이라는 보안 경계 자체이므로 생략할 수 없습니다. Main을 종료하기 전에 `bridge.dispose()`로 연결을 해제해야 합니다. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, 고정 preload, 탐색 및 창 생성 제한, 명시적 신뢰 origin 허용 목록을 사용하세요. `dispose()` 뒤 서버와 bind는 다시 쓸 수 없습니다 — 되돌릴 수 없는 종료이므로, 다시 연결하려면 새 `createBridgeServer`와 `bindElectronBridge`를 만드세요.

`api.dispose()`(`api[Symbol.dispose]`와 같은 함수)는 진행 중 RPC를 취소하고 활성 구독을 정리하는 명시적 teardown입니다. hello-world처럼 창이 떠 있는 동안에는 호출할 필요가 없습니다 — 창을 닫거나 reload하면 Main이 이미 그 문서 세션을 회수합니다. `dispose()`는 브리지가 살아있는 동안 Renderer 스스로 정리를 끝내고 싶을 때(SPA 라우팅으로 화면을 벗어나며 그 화면의 구독을 끊는 경우 등) 쓰는 용도입니다. 근거는 [ADR 0013](../../docs/adr/0013-wiring-defaults.md)에 있습니다.

### 배선 기본값

| 옵션                                        | 위치                                                            | 생략 시                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`                                 | `bindElectronBridge`, `exposeBridgeInMainWorld`                 | `"default"`(Main·preload 공통 상수). 채널은 `rx-bridge-electron:v1:default:*`가 됩니다.                                                                             |
| `role`                                      | `attach(contents, role?)`                                       | `"default"`. `authorize`의 `context.windowRole`로 전달되므로 역할로 인가를 나누는 앱은 명시합니다.                                                                  |
| `globalName`                                | `exposeBridgeInMainWorld`, `createRendererApi`가 읽는 전역 이름 | `"rxBridge"`(`window.rxBridge`)                                                                                                                                     |
| `ipcMain` / `contextBridge` / `ipcRenderer` | `bindElectronBridge` / `exposeBridgeInMainWorld`                | 생략 시 호출 시점에 `import * as electron from "electron"`으로 해석(`electron.ipcMain` 등). 둘 다 없으면(비-Electron 런타임) `TypeError`. 주입값이 항상 우선합니다. |
| `transport`                                 | `createRendererApi<B>(options?)`                                | `globalThis.rxBridge`를 읽습니다. 없거나 transport 형태가 아니면 `rxBridge`·`exposeBridgeInMainWorld`를 언급하는 `TypeError`.                                       |

기본값과 해석 순서의 근거는 [ADR 0013](../../docs/adr/0013-wiring-defaults.md)에 있습니다.

### 명시 형태

기본값을 그대로 쓰면 위 hello-world로 충분합니다. 아래는 명시적으로 지정해야 하는 경우입니다.

**여러 namespace(다중 브리지)** — 서로 다른 도메인을 별도 채널로 격리하려면 `namespace`를 각각 지정합니다. 한 브리지 안에서 창마다 다른 `role`로 인가를 나누는 것(예: 데모의 `main`/`monitor`)과는 다른 상황입니다 — namespace는 채널 자체를 분리합니다.

```ts
// Main — 독립된 두 브리지
const deviceBridge = bindElectronBridge({
  server: deviceServer,
  namespace: "device",
  allowedOrigins: ["file://"],
});
const settingsBridge = bindElectronBridge({
  server: settingsServer,
  namespace: "settings",
  allowedOrigins: ["file://"],
});
deviceBridge.attach(win.webContents);
settingsBridge.attach(win.webContents);
```

```ts
// Preload — 같은 namespace로 맞춰야 채널이 일치합니다.
exposeBridgeInMainWorld({ namespace: "device", globalName: "deviceBridge" });
exposeBridgeInMainWorld({
  namespace: "settings",
  globalName: "settingsBridge",
});
```

**globalName을 바꾼 경우** — `exposeBridgeInMainWorld`의 `globalName`을 기본값과 다르게 쓰면 `createRendererApi`는 그 이름을 자동으로 찾지 못합니다. `contextBridge`가 노출한 전역을 직접 읽어 `transport`로 넘기고, 그 전역의 타입을 알리는 `declare global`을 다시 선언해야 합니다(기본 경로에서는 라이브러리가 이미 `Window.rxBridge`를 선언하므로 필요 없습니다).

```ts
// Preload
import { exposeBridgeInMainWorld } from "@cp949/rx-bridge-electron/preload";

exposeBridgeInMainWorld({ globalName: "appBridge" });
```

```ts
// Renderer
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import type { BridgeTransport } from "@cp949/rx-bridge-electron/renderer";
import type { AppBridge } from "./bridge/contract.js";

declare global {
  interface Window {
    readonly appBridge: BridgeTransport;
  }
}

const api = await createRendererApi<AppBridge>({ transport: window.appBridge });
```

**테스트에서 electron/transport를 주입하는 경우** — 유닛 테스트는 Electron 프로세스 밖에서 실행되므로 `electron.ipcMain`/`electron.contextBridge`/`electron.ipcRenderer`를 얻을 수 없습니다. Main·preload 테스트는 이 값들을 직접 주입하고, Renderer 테스트는 mock `BridgeTransport`를 만들어 `createRendererApi`에 넘깁니다(패키지 테스트의 `FakeIpcMain`/`FakeContextBridge`/`FakeIpcRenderer`/`FakeTransport`와 같은 형태).

```ts
// Main 테스트
const bridge = bindElectronBridge({
  ipcMain: fakeIpcMain,
  server,
  allowedOrigins: ["file://"],
});
```

```ts
// preload 테스트
exposeBridgeInMainWorld({
  contextBridge: fakeContextBridge,
  ipcRenderer: fakeIpcRenderer,
});
```

```ts
// Renderer 테스트
const api = await createRendererApi<AppBridge>({ transport: fakeTransport });
```

## 스키마 점진 도입

도메인 스키마는 선택이며 operation 단위로 부분·점진 도입합니다. 위 hello world는 스키마 없이 동작합니다 — 구조·크기 검사(`parseBridgeValue`)는 스키마 유무와 무관하게 항상 적용됩니다(아래 "검증, 한도, 범위 밖 기능" 참고).

검증하고 싶은 operation만 `options.schemas`에 채웁니다. 타입은 `SchemasFor<AppBridge>`에서 도출되어 경로 오타와 스키마 출력 타입 불일치를 컴파일 에러로 잡습니다. 스키마는 `Schema<T>`(`parse(value: unknown): T`) 구조면 되고 zod에 의존하지 않습니다.

```ts
import { createBridgeServer } from "@cp949/rx-bridge-electron/main";
import type { Schema } from "@cp949/rx-bridge-electron/contract";

const connectionSchema: Schema<{ readonly connected: boolean }> = {
  parse(value) {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as { connected?: unknown }).connected !== "boolean"
    )
      throw new TypeError("Invalid connection");
    return value as { readonly connected: boolean };
  },
};

const server = createBridgeServer(impl, {
  schemas: { device: { state: { connection: connectionSchema } } },
});
```

RPC는 `{ input?: Schema<I>; output?: Schema<O> }`, State·Event는 `Schema<T>` 하나입니다. 입력이 없는 RPC는 `input` 항목 자체가 없습니다. 없는 항목은 도메인 스키마 없이 통과합니다. 요청 처리 순서는 `parseBridgeValue(input)`(항상) → 입력 스키마(있으면, 실패 시 `INVALID_ARGUMENT`) → handler → 출력 스키마(있으면) → `parseBridgeValue` + clone(항상)입니다.

스키마를 계약·구현과 분리된 파일에 두고 싶으면 `satisfies SchemasFor<AppBridge>`로 타입 검사를 유지한 채 값만 다른 파일에 둡니다(예: `main/schemas.ts`). 여러 operation에 걸쳐 스키마를 선언·조합하는 실제 예시는 `packages/rx-bridge-electron/test/main/impl-schemas-fixture.ts`, 데모 앱의 `apps/demo/src/main/schemas.ts`에 있습니다.

```ts
// main/schemas.ts
export const schemas = {
  device: { state: { connection: connectionSchema } },
} satisfies SchemasFor<AppBridge>;

// main/index.ts
import { schemas } from "./schemas.js";
const server = createBridgeServer(impl, { schemas });
```

스키마는 Main에만 두며 Renderer 번들에 포함되지 않습니다 — Renderer는 계약 타입만 참조합니다.

## 허용 에러 코드

`options.errors: ErrorsFor<AppBridge>`도 계약과 같은 모양의 선택적 중첩 map이며, RPC operation에만 허용 도메인 에러 코드 목록(`readonly string[]`)을 둘 수 있습니다. handler가 `code`·`message`(그리고 선택적으로 clone-safe `details`)를 가진 값을 던지고 그 `code`가 목록에 있으면 그 코드로 응답하고, 목록에 없거나 형태가 어긋나면 안전한 `INTERNAL` 오류로 바뀝니다. Renderer 쪽 에러 코드 타입 추론은 하지 않습니다(범위 밖).

```ts
export const errors = {
  device: { rpc: { connect: ["DEVICE_TIMEOUT"] } },
} satisfies ErrorsFor<AppBridge>;

// handler 안에서
throw Object.assign(new Error("Device response timeout"), {
  code: "DEVICE_TIMEOUT",
});

const server = createBridgeServer(impl, { errors });
```

## Event buffer 옵션

계약은 타입이라 값을 담을 수 없으므로, Event buffer(용량과 overflow 정책)는 Main에서 source를 만들 때 옵션으로 둡니다. 생략하면 기본값(`capacity: 100`, `overflow: "error"`)을 씁니다.

```ts
import { Subject } from "rxjs";
import { broadcastEvent, scopedEvent } from "@cp949/rx-bridge-electron/main";

const data$ = new Subject<{ readonly text: string }>();

// 문서 세션 전체가 하나의 upstream을 공유합니다.
const dataEvent = broadcastEvent(data$, {
  buffer: { capacity: 256, overflow: "drop-oldest" },
});

// 구독마다 별도 upstream을 만듭니다(context별로 다른 값을 흘려보낼 때).
const scopedDataEvent = scopedEvent(
  (context) => data$, // 또는 context.windowRole에 따라 다른 Observable
  { buffer: { capacity: 64, overflow: "error" } },
);
```

`overflow`는 `"error"`(대기 값 전달 뒤 `STREAM_OVERFLOW`로 종료), `"drop-oldest"`, `"drop-newest"` 중 하나입니다. plain `Observable<T>`을 그대로 impl에 두면 buffer 옵션 없이 기본값을 씁니다.

잘못된 buffer(`capacity`, `overflow`)나 source 모양은 helper를 쓰지 않은 직접 작성 source를 포함해 `createBridgeServer` 호출 시 `TypeError`로 실패합니다.

## 런타임 동작

`createRendererApi()`는 API 객체를 반환하기 전에 handshake를 수행합니다. Main 서버는 직렬화 가능한 manifest를 제공하고, Renderer는 그 manifest로 선언된 경로만 담은 `Object.freeze`된 일반 객체 트리를 만듭니다. 선언되지 않은 경로는 `undefined`이고, 쓰기는 `TypeError`로 실패하며, `then` 속성이 없어 Promise처럼 동작하지 않습니다(근거: [ADR 0021](../../docs/adr/0021-renderer-frozen-api-tree.md)). 정식 operation 경로는 Renderer가 제공한 객체 경로가 아니라 범주를 포함합니다(`rpc:device/connect`, `state:device/connection`). 공개 호출 형태는 도메인 아래에 종류 계층을 두는 `api.<domain path>.rpc|state|event.<operation>`입니다(`api.device.rpc.connect()`, `api.device.state.connection`, `api.device.event.data`). 도메인에 정의가 없는 종류는 노출하지 않습니다. operation 이름은 `/`를 포함할 수 없고, 묶음은 중첩 도메인(`{ device: { serial: { rpc: {...} } } }` → `api.device.serial.rpc.open()`)으로 표현합니다. 도메인 경로의 segment로 `rpc`, `state`, `event`를 쓸 수 없습니다(근거: [ADR 0007](../../docs/adr/0007-hierarchical-renderer-api.md)).

루트 API는 `api.dispose()`와 `api[Symbol.dispose]`를 같은 함수로 노출하며, 호출은 되돌릴 수 없는 최종 종료입니다(근거: [ADR 0006](../../docs/adr/0006-shutdown-contract.md)). 진행 중인 RPC는 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 즉시 reject되고, 이미 Main에 전송된 요청에는 best-effort cancel을 보냅니다. 활성 State/Event 구독은 `unsubscribe` 전송 후 `complete()`됩니다(`error`가 아닙니다). 종료 후 호출한 RPC·subscribe는 전송 없이 같은 `CANCELLED` 오류로 끝납니다. 반복 `dispose()` 호출은 no-op입니다. `dispose`는 루트 도메인 이름으로 예약되어 있어 최상위 도메인 이름이 `dispose`인 계약(`{ dispose: {...} }`, `{ dispose: { x: {...} } }`)은 거부됩니다. 하위 segment나 operation 이름으로는 계속 쓸 수 있습니다(예: `device/dispose` 도메인, `api.device.rpc.dispose`).

각 RPC는 structured clone이 가능한 입력값 하나를 받습니다. `AbortSignal`과 `timeoutMs`는 별도 `CallOptions`로 전달합니다. 취소, timeout, 응답 중 먼저 일어난 하나만 최종 결과가 됩니다. 원격 실패는 `FORBIDDEN`, `INVALID_ARGUMENT`, `CANCELLED`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED` 같은 프로토콜 코드를 가진 `RemoteError` 값으로 전달됩니다. `DEADLINE_EXCEEDED`는 Renderer의 로컬 `timeoutMs`뿐 아니라 Main이 `resourceLimits.maxRpcDurationMs`로 스스로 설정한 서버 deadline에서도 올 수 있습니다 — 둘 중 먼저 확정되는 쪽이 최종 결과입니다.

`RemoteState<T>`는 읽기 전용 Observable이며 `.snapshot`을 제공합니다.

- `uninitialized`: 값이 없고 활성 원격 구독도 없습니다.
- `connecting`: 첫 로컬 구독자가 원격 구독을 열었습니다.
- `current`: Main의 현재값을 받았습니다. 구독자에게 알리기 전에 snapshot에 반영됩니다.
- `stale`: 값이 존재한 상태에서 마지막 구독자가 구독을 해제했습니다. 오래된 데이터는 이후 generation의 새 값으로 재생하지 않습니다.

같은 generation이 활성인 동안 늦게 합류한 로컬 구독자는 `subscribe()` 호출 안에서 현재값을 동기로 1회 받습니다. `undefined`도 유효한 현재값으로 전달됩니다. 아직 값을 받지 못한 `connecting` 상태(첫 로컬 구독자가 원격 구독을 열었지만 첫 값이 도착하기 전)에서 늦게 구독하면 즉시 아무 값도 받지 않고 첫 값을 기다립니다.

하나의 Renderer 문서 안에서는 여러 State/Event 구독자가 로컬 source를 공유합니다. Main의 소유 범위는 연결된 `webContents`와 문서 세션입니다. reload, 탐색, 완료, 오류, 마지막 구독 해제, 문서 파괴 시 관련 자원을 정리합니다. State는 현재값을 우선 전달합니다. Event는 재생하지 않으며 `subscribed` 확인 이후 순서를 보장하고 최대 한 번 전달합니다. Event buffer는 용량과 overflow 정책(`error`, `drop-oldest`, `drop-newest`)을 명시해야 합니다(위 "Event buffer 옵션" 참고, 생략 시 기본값).

문서가 살아있는 채로 Main 쪽 세션이 끝나면(detach 또는 `server.dispose()`/bind `dispose()`), 활성 State/Event 구독과 `authorize` 대기 중이던 구독은 `RemoteError("CANCELLED", "Bridge session ended.")`를 받습니다 — `RemoteState`는 값이 있었으면 `stale`, 없었으면 `uninitialized`로 전이하고, 쌓여 있던 값은 전달하지 않습니다. 세션이 끝난 뒤의 새 구독은 `subscribed` 확인 직후 같은 `RemoteError("FORBIDDEN", "Bridge sender is not authorized.")`로 끝납니다(RPC 거부와 같은 코드·문구). navigation(문서 commit 시점, [ADR 0019](../../docs/adr/0019-navigation-retire-on-commit.md))·renderer process 종료·문서 파괴·같은 문서의 새 클라이언트 등록으로 인한 retire는 통지하지 않습니다 — 옛 문서 자신이 이미 없거나 재연결 흐름의 일부이기 때문입니다. 전송 실패는 삼킵니다(best-effort). 근거는 [ADR 0020](../../docs/adr/0020-stream-terminal-on-retire.md)에 있습니다.

### Renderer 진단

`createRendererApi<B>(options)`의 `diagnostics` 옵션으로 `RendererDiagnosticsSink`를 연결하면 RPC 확정 원인, 원격 구독의 시작·종료 원인, 스트림 메시지 폐기, handshake 실패, `transport.cancel`·`transport.control`(unsubscribe·acknowledge) 전송 실패 삼킴을 이벤트 6종(`rpc-settled`·`subscription-opened`·`subscription-closed`·`handshake-failed`·`message-dropped`·`transport-failed`)으로 관측할 수 있습니다. `rpc-settled`는 호출 하나당 정확히 1회, `subscription-opened`/`subscription-closed`는 원격 구독(generation) 단위로 1쌍씩 기록됩니다. 식별자는 등록된 와이어 key만 실리며(`RemoteError.code`는 `cause: "remote-error"`일 때만 예외로 포함), `Error` 객체·`message`·`stack`·`details`·원문 payload·`requestId`·`subscriptionId`·`clientId`는 어떤 이벤트에도 넣지 않습니다. `sink`가 없거나 `record`가 예외를 던져도 API 동작은 같고, 지정하지 않으면 콘솔 출력이 없습니다. 스냅샷 조회는 없습니다 — 활성 구독 수는 `subscription-opened`/`closed` 쌍으로 셀 수 있습니다.

```ts
const api = await createRendererApi<AppBridge>({
  diagnostics: {
    record: (event) => {
      if (event.type === "rpc-settled" && event.cause !== "ok")
        metrics.increment(`renderer.rpc-settled.${event.cause}`);
    },
  },
});
```

`RpcClient`·`StreamMultiplexer`는 Renderer main world에서 실행되므로 sink 콜백은 `contextBridge`를 건너지 않습니다. 이벤트 타입·원인 판정 전체 목록은 [ADR 0022](../../docs/adr/0022-renderer-diagnostics.md)에 있습니다.

## 검증, 한도, 범위 밖 기능

Main은 핸들러를 호출하기 전에 RPC 입력을, 전송하기 전에 출력을, 전달하기 전에 스트림 값을 검증합니다. v1 payload는 `undefined`, `null`, 원시 값, 배열, 일반 객체 트리만 허용합니다. 순환 참조, 함수, symbol, 사용자 정의 prototype, typed array, transferable을 거부합니다. 기본 한도는 깊이 32, 항목 10,000개, 문자열당 UTF-8 1,000,000 byte, 전체 크기 16 MiB(`maxTotalBytes`)입니다. 전체 크기는 노드·문자열 byte·bigint 자릿수를 순회하며 근사 계산한 값이라 실제 V8 structured clone 크기와 다를 수 있습니다. `createBridgeServer`의 `payloadLimits` 서버 옵션으로 필드별 상향·하향이 가능하며, 이 한도는 서버가 강제합니다(Electron 어댑터·preload는 envelope 구조만 검사합니다). 기본값은 `DEFAULT_PAYLOAD_LIMITS`로 가져올 수 있고, 필드에 `undefined`를 넣으면 생성 시점에 `TypeError`가 발생합니다. 이 구조·크기 검사는 도메인 스키마(`options.schemas`) 유무와 무관하게 모든 operation에 항상 적용됩니다 — 줄어드는 것은 사용자가 손으로 쓰는 코드량이지 이 검사가 아닙니다.

입력과 출력의 검증 실패는 서로 다른 오류 코드로 응답합니다. 요청 envelope나 RPC 입력이 이 규칙을 어기면 `INVALID_ARGUMENT`로 거부됩니다. 반면 RPC 출력과 스트림(State/Event) 값의 검증 실패는 `INTERNAL`입니다 — handler나 출력 스키마가 만든 값도 전송 전에 같은 규칙으로 다시 검증하며, 출력 스키마가 변환한 결과도 예외 없이 재검사 대상입니다. handler가 선언되지 않은 예외를 던지거나 출력 스키마 자체가 예외를 던져도(선언된 오류 코드를 가진 예외라도) `INTERNAL`로 응답하고, 선언된 도메인 에러라도 `message`나 `details`가 위 한도를 넘으면 `INTERNAL`로 대체됩니다. `authorize` 콜백이 예외를 던지거나 reject해도 RPC·State·Event 모두 `INTERNAL`입니다. 검증 실패 시점에 요청이 이미 취소된 상태라면 `CANCELLED`가 우선합니다.

Main은 세션(연결된 `webContents`의 현재 문서)별로 진행 중 RPC 수, 구독 수, RPC 실행 시간, retired client ID 보관량도 제한합니다. `createBridgeServer`의 `resourceLimits` 옵션으로 설정하며, 지정하지 않은 필드는 기본값을 씁니다.

```ts
const server = createBridgeServer(impl, {
  resourceLimits: {
    maxConcurrentRpc: 32, // 기본 64
    maxSubscriptions: 128, // 기본 256
    maxRpcDurationMs: 60_000, // 기본 300_000, 최대 2_147_483_647, Infinity로 deadline을 끌 수 있음
    maxRetiredClientsPerWebContents: 16, // 기본 32
  },
});
```

한도를 넘으면 세션별로 격리된 오류로 끝나고 다른 세션에는 영향이 없습니다: 동시 RPC·구독 수 초과는 `RESOURCE_EXHAUSTED`, Main deadline 경과는 `DEADLINE_EXCEEDED`(handler의 `AbortSignal`도 abort됩니다). `AbortSignal`을 무시하는 handler는 자기 세션의 RPC 슬롯만 계속 점유합니다. 근거는 [ADR 0009](../../docs/adr/0009-session-resource-limits.md)에 있습니다.

`createBridgeServer`의 `diagnostics` 옵션으로 `DiagnosticsSink`를 연결하면 RPC 완료(성공·실패 `outcome` 포함)·취소·Main deadline 만료, 출력 검증 실패, Event 큐 깊이·드롭, 보안·입력·자원 한도 거부 사유(`rejected`, 11개 `RejectReason`), 세션·구독의 생성과 해제를 닫힌 타입 이벤트로 관측할 수 있습니다. 사유는 enum 코드, 식별자는 등록된 와이어 key만 실리며 자격 증명·원시 payload·origin·clientId·requestId·subscriptionId·`Error` 객체는 어떤 이벤트에도 넣지 않습니다. `sink`가 없거나 `record`가 예외를 던져도 bridge 동작은 같고, 지정하지 않으면 콘솔 출력이 없습니다.

```ts
const server = createBridgeServer(impl, {
  diagnostics: {
    record: (event) => {
      if (event.type === "rejected")
        metrics.increment(`bridge.rejected.${event.reason}`);
    },
  },
});

// 현재 활성 세션·RPC·구독 수와 대기 중 Event 수(스냅샷, 누적 아님)
const { sessions, rpcInFlight, subscriptions, queuedEvents } =
  server.getDiagnosticsSnapshot();
```

대용량 바이너리 전송과 지속적인 고속 스트림은 현재 범위에 포함되지 않습니다. 향후 이 기능이 필요하면 이 API에서 원시 IPC를 노출하지 말고 별도의 MessagePort 어댑터 뒤에 구현합니다. 이벤트 종류 전체와 각 `RejectReason`의 판정 지점은 [ADR 0010](../../docs/adr/0010-operational-diagnostics.md)에 있습니다.

## Testing

라이브러리 사용자의 test에서 preload/IPC 대신 실제 `server` + 실제 `createRendererApi`를 함께 쓰고 싶다면 `@cp949/rx-bridge-electron/testing`의 `createLoopbackTransport`를 씁니다. wire 형식(envelope·opaque ID·manifest)을 손으로 만들 필요가 없습니다 — 실제 server를 거치므로 wire 형식이 바뀌어도 이 방식으로 작성한 test는 바뀌지 않습니다.

```ts
import { createBridgeServer } from "@cp949/rx-bridge-electron/main";
import { createLoopbackTransport } from "@cp949/rx-bridge-electron/testing";
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import type { AppBridge } from "./bridge/contract.js";

const server = createBridgeServer(impl, options);
const transport = createLoopbackTransport(server, { role: "main" });
const api = await createRendererApi<AppBridge>({ transport });

await api.device.rpc.connect();

transport.dispose(); // detach만 한다 — server는 여전히 살아 있다
server.dispose();
```

`createLoopbackTransport(server, options?)`는 `BridgeTransport & { dispose(): void }`를 반환합니다. `server: StreamBridgeServer`는 `createBridgeServer`가 만든 것을 그대로 넘기며, `createLoopbackTransport`가 내부에서 server를 만들지는 않습니다. `options`:

| 옵션       | 기본값                                                                           | 설명                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sender`   | `{ webContentsId: 1, frameId: 1, isMainFrame: true, origin: "loopback://test" }` | `Partial<SenderIdentity>`, 지정한 필드만 덮어씁니다. 다중 창은 `webContentsId`(필요하면 `frameId`도)를 다르게 준 transport를 여러 개 만듭니다. |
| `clientId` | `"loopback-client"`                                                              | 같은 `server`에 여러 transport를 붙일 때는 서로 다른 값을 주세요 — 같은 `webContentsId`에서 한 번 retire된 `clientId`는 재사용할 수 없습니다.  |
| `role`     | `"default"`                                                                      | `server.attach`에 넘기는 target의 role — `authorize`의 `context.windowRole`로 전달됩니다.                                                      |

요청·응답과 stream 메시지 모두 `structuredClone`을 거치고 참조를 공유하지 않습니다. envelope 조립(`withEnvelope`)과 검사(`parseRendererRpcRequest`·`parseRendererStreamCommand`·`parseHandshakeResponse`·`parseRpcResponse`·`parseStreamMessage`)는 preload와 같은 protocol 함수를 쓰므로 같은 입력에서 preload와 같은 지점에서 실패합니다 — 예: server가 handshake를 거부하면 `connect()`가 reject되고 `createRendererApi`는 `INTERNAL`로 실패합니다. `cancel`·`control` 호출과 stream 메시지 전달은 microtask로 미뤄집니다(`control()`이 반환되기 전에 `onStreamMessage` listener가 불리지 않습니다). `server`가 던지는 예외는 폴백 없이 그대로 드러납니다(운영 adapter의 try/catch 폴백을 공유하지 않습니다). `dispose()`는 detach와 listener 해제만 합니다 — `server`는 dispose하지 않으므로 같은 `server`에 새 loopback transport를 계속 만들 수 있습니다.

운영(production) 코드에서는 쓰지 않습니다 — Renderer는 여전히 고정 preload transport만 받아야 합니다([ADR 0001](../../docs/adr/0001-fixed-preload-capability.md)). 근거는 [ADR 0017](../../docs/adr/0017-loopback-test-transport.md)에 있습니다.

## 호환성 변경

이전 버전에서 올라오는 경우 다음을 확인하세요.

1. **기본 자원 한도로 이전에 통과하던 호출이 실패할 수 있습니다.** 5분을 넘는 RPC, 16 MiB를 넘는 payload, 세션당 64개를 넘는 동시 RPC, 세션당 256개를 넘는 구독이 이제 기본값에서 거부됩니다. 위 예제처럼 서버 옵션 `resourceLimits`(RPC·구독·시간·retired 보관)나 `payloadLimits`(`maxTotalBytes` 포함)로 상향하세요. Renderer에서 `timeoutMs: Infinity`를 쓰던 호출은 Main `maxRpcDurationMs`도 `Infinity`로 맞춰야 Main이 먼저 `DEADLINE_EXCEEDED`로 끊지 않습니다.
2. **사용자 정의 transport(자체 `BridgeTransport` 구현)는 `subscriptionId`를 `<nonce>:<scope>:<seq base36>` 형식으로, 한 문서 세션 안에서 증가하는 순서로 보내야 합니다.** Main이 세션별 워터마크로 재사용·늦은 도착을 판정하기 때문입니다. `@cp949/rx-bridge-electron/renderer`가 공개하는 `createOpaqueId(scope)`를 그대로 쓰는 것을 권장합니다. 형식에 맞지 않는 ID는 `INVALID_ARGUMENT`로 거부됩니다.
3. **`TransportErrorCode`에 `RESOURCE_EXHAUSTED`가 추가됐습니다.** 오류 코드를 망라해 분기하던(`switch`의 `default`가 없거나 union을 좁게 전제한) 코드는 이 코드도 처리하도록 확인하세요.
4. **`payloadLimits`가 서버 옵션이 되며 Electron 어댑터에도 적용됩니다.** 이전에는 어댑터가 하드코딩된 한도로 wire를 먼저 검사해 더 큰 한도를 선언해도 실제로는 동작하지 않았습니다. 기본값보다 큰 `payloadLimits`를 선언했다면 이제 그 한도만큼 큰 입력이 실제로 handler까지 도달합니다. (RD-018부터 envelope 단계 파싱 자체는 Electron 어댑터가 아니라 server가 직접 합니다 — 이 단계는 여전히 `payloadLimits`가 아닌 고정된 넉넉한 한도를 쓰므로 이 항목의 동작은 바뀌지 않았습니다.)
5. **`DiagnosticsSink`로 받는 `rpc-finished` 이벤트에 `outcome: "ok" | "error"` 필드가 추가됐습니다.** `BridgeDiagnostic`을 망라해 분기하던(`switch`의 `default`가 없거나 이벤트 모양을 좁게 전제한) sink 구현은 이 필드와 새 이벤트 6종(`rpc-timed-out`, `rejected`, `session-opened`, `session-closed`, `subscription-opened`, `subscription-closed`)도 처리하도록 확인하세요.
6. **계약을 런타임 값(도메인 조합 함수로 만들던 descriptor 트리)으로 선언하던 API는 순수 TS 타입으로 바뀌었습니다.** 도메인 조합 함수가 반환하던 구현 객체는 `impl: BridgeImpl<B>`의 해당 도메인 필드로, 계약·구현·옵션 3개 인자를 받던 서버 생성 함수는 `createBridgeServer<B>(impl, options)`로 바뀌었습니다. 계약에서 Renderer 타입을 추론하던 옛 타입은 `BridgeApi<B>`(`B`는 계약 타입)로 바뀌었습니다. 옛 API 이름과 자세한 이전 방법은 [ADR 0012](../../docs/adr/0012-lightweight-type-contract.md)의 "이전(migration)" 절에 있습니다.
7. **미등록 State/Event key로 구독하면 `authorize` 결과와 무관하게 항상 `NOT_FOUND`입니다.** 이전에는 `authorize`가 deny할 때만 `FORBIDDEN`이었고, allow할 때만(그리고 그 이후에야) `NOT_FOUND`였습니다. `authorize` 콜백은 이제 등록된 key만 받습니다 — 모든 key를 무조건 허용하던 구현이라도 동작에 영향은 없습니다. 자세한 내용은 [ADR 0014](../../docs/adr/0014-stream-lookup-before-authorize.md)에 있습니다.
8. **`StreamBridgeServer`(`handshake`·`controlStream`)와 부모 `BridgeServer`(`dispatchRpc`·`cancel`)를 직접 구현하거나 직접 호출하는 코드는 시그니처가 바뀝니다.** 두 번째 인자가 `unknown`이 되어 채널별 envelope 객체(`{ protocolVersion, clientId, ... }`)를 넘겨야 합니다 — `clientId` 문자열만 넘기던 호출은 컴파일은 통과하지만 런타임에 `malformed-envelope`로 거부됩니다. `handshake`의 반환 타입은 `unknown`에서 `HandshakeResponse | RpcResponse`로 좁혀졌습니다(성공은 `manifest`를 가진 `HandshakeResponse`, 거부는 `error.code === "INVALID_ARGUMENT"`인 `RpcResponse`). `DiagnosticsSink`로 관측하는 진단 사유도 바뀝니다: `frame-not-main`/`origin-not-allowed`가 handshake뿐 아니라 RPC·subscribe·unsubscribe/acknowledge·cancel 모든 채널에서 날 수 있고, cancel 거부도 이제 `rejected`로 기록됩니다. 숫자 `protocolVersion` 불일치는 4채널 모두 `version-mismatch`로 기록되고 RPC wire 응답은 `VERSION_MISMATCH "Unsupported protocol version."`입니다(이전에는 `malformed-envelope` + `INVALID_ARGUMENT`). 구조 오류 input(Symbol·함수 등)은 server를 직접 호출해도 등록 조회·`authorize` 전에 `malformed-envelope` + `INVALID_ARGUMENT "Invalid bridge request."`로 거부됩니다. attach하지 않은 `webContents`가 보낸 handshake는 origin과 무관하게 `sender-unauthorized`입니다(이전에는 `origin-not-allowed`). 근거는 [ADR 0016](../../docs/adr/0016-sender-admission.md)에 있습니다.
9. **`@cp949/rx-bridge-electron/protocol`이 공개하는 `parse*` 9개(`parseHandshakeRequest`·`parseHandshakeResponse`·`parseRendererRpcRequest`·`parseRendererStreamCommand`·`parseRpcResponse`·`parseStreamMessage`·`parseWireCancelRequest`·`parseWireRpcRequest`·`parseWireStreamCommand`)가 두 번째 `limits` 인자를 받지 않습니다.** 이 함수들을 직접 호출하던 코드는 두 번째 인자를 지우면 됩니다 — envelope 파싱 한도 값 자체는 이전과 같고(고정된 넉넉한 한도), 정의 위치만 protocol 내부 상수 `ENVELOPE_LIMITS`로 옮겨졌습니다. `@cp949/rx-bridge-electron/protocol`은 신규로 `PROTOCOL_VERSION`(현재 프로토콜 버전 리터럴)과 `withEnvelope(clientId, body)`(envelope 조립 helper, 반환 타입은 `ProtocolEnvelope & T`)도 공개합니다. `parseBridgeValue(value, limits)`의 시그니처는 바뀌지 않았습니다.
10. **`@cp949/rx-bridge-electron/renderer`에서 `RpcClient`·`RpcClientOptions`·`HandshakeWithManifest`가 제거됐습니다.** RPC 호출은 `createRendererApi`가 반환한 api로 하고, handshake 타입이 필요하면 `@cp949/rx-bridge-electron/protocol`의 `HandshakeResponse`를 쓰세요. 전역 기본 timeout(`defaultTimeoutMs`) option도 없어졌습니다 — 호출마다 `timeoutMs`를 주세요(기본값은 내부 상수 30초로 불변입니다).
11. **한 RPC 요청은 `rpc-timed-out`과 `rpc-cancelled` 중 먼저 확정된 진단 하나만 남깁니다.** 이전에는 Main deadline 만료 뒤 handler가 끝나기 전에 Renderer `cancel`이나 세션 retire가 오면 `rpc-cancelled`가 추가로 기록됐고, 취소 뒤 signal을 무시한 handler가 deadline을 넘기면 `rpc-timed-out`이 추가로 기록됐습니다. 두 이벤트를 합산하던 진단 소비자는 이제 요청당 1회로 셉니다. 취소가 먼저 확정된 요청은 deadline 시점에 `DEADLINE_EXCEEDED` 대신 `CANCELLED`로 응답합니다 — Renderer는 cancel을 보내기 전에 호출을 이미 로컬에서 확정하므로 `createRendererApi` 호출 결과는 바뀌지 않고, `dispatchRpc`를 직접 호출하는 코드만 차이를 봅니다. 근거는 [ADR 0010](../../docs/adr/0010-operational-diagnostics.md) §8에 있습니다.
