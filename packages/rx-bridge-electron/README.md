# rx-bridge-electron

신뢰하는 로컬 UI를 위한 타입 기반 Electron IPC 라이브러리입니다. Main과 Renderer 사이에 세 가지 통신을 제공합니다.

- **RPC**: 요청/응답. Renderer에서 `Promise`로 받습니다.
- **State**: 현재값이 있는 스트림. 구독하면 현재값부터 받습니다.
- **Event**: 재생하지 않는 스트림. 구독한 뒤에 일어난 값만 받습니다.

스트림 API는 RxJS만 씁니다.

## 목차

1. [진입점](#진입점)
2. [설치](#설치)
3. [시작하기](#시작하기)
4. [Renderer에서 쓰기](#renderer에서-쓰기): API 모양, RPC, State, Event, 오류 코드, 구독 종료 원인, `api.dispose()`
5. [프레임워크 연동](#프레임워크-연동): React, Event·RPC 직접 사용, TanStack Query
6. [Main 구현](#main-구현): `impl`과 `authorize`, 스키마, 허용 에러 코드, Event buffer, State source 교체
7. [Electron 연결](#electron-연결): 보안 설정, 기본값, 명시 형태
8. [한도와 진단](#한도와-진단): 값 규칙과 크기 한도, 세션 자원 한도, Main 진단, Renderer 진단
9. [테스트](#테스트)
10. [범위 밖](#범위-밖)

동작의 모든 경우와 설계 이유는 [설계 문서](../../docs/design/README.md)에 있습니다. 이 README는 사용법만 다룹니다.

## 진입점

| 진입점                               | 실행 위치     | 책임                                                                           |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `@cp949/rx-bridge-electron/contract` | 모든 프로세스 | 계약 타입에서 파생하는 타입(`BridgeApi`/`BridgeImpl`/`SchemasFor`/`ErrorsFor`) |
| `@cp949/rx-bridge-electron/main`     | Main          | 서버 생성, 핸들러 연결, 권한 확인, 검증, 세션, 진단 정보                       |
| `@cp949/rx-bridge-electron/preload`  | preload       | `contextBridge`로 노출하는 고정 Electron 채널 어댑터                           |
| `@cp949/rx-bridge-electron/renderer` | Renderer      | 동결 API 객체, RPC 클라이언트, `RemoteState`, RxJS Event, 진단 sink            |
| `@cp949/rx-bridge-electron/testing`  | 테스트        | 실제 서버와 Renderer API를 IPC 없이 잇는 loopback transport                    |

계약은 런타임 값이 아니라 순수 TS 타입입니다. 핸들러, Electron 객체, 자격 증명, Node API, 함수, `Observable`, `Subject`는 preload 경계를 넘지 않습니다.

`rxjs`와 `electron`은 peer dependency입니다. Electron 런타임은 애플리케이션이 소유합니다. preload는 대상 Electron 버전에 맞게 애플리케이션이 번들링합니다.

## 설치

```sh
npm install @cp949/rx-bridge-electron rxjs electron
```

저장소: <https://github.com/cp949/rx-bridge-electron>

## 시작하기

RPC 1개와 State 1개를 쓰는 최소 예제입니다. 계약은 도메인들의 중첩 객체 타입이고, 각 도메인은 `rpc`·`state`·`event` 카테고리를 가집니다. 스키마나 zod는 필요 없습니다.

```ts
// bridge/contract.ts — 공유 선언만 둡니다.
export type AppBridge = {
  device: {
    rpc: { connect(): { readonly connected: boolean } };
    state: { connection: { readonly connected: boolean } };
  };
};
```

Main은 두 부분입니다. 첫 블록은 도메인 서버를 만들고, 두 번째 블록은 그 서버를 Electron IPC에 연결합니다.

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
// Renderer — 사용 예(연결 설정이 아닙니다)
await api.device.rpc.connect();
api.device.state.connection.subscribe({
  next: console.log,
  error: console.error,
});
```

`impl`이 계약과 어긋나면(operation 누락, handler·source 형태 오류, 객체 리터럴의 초과 operation) 컴파일에 실패합니다. 자세한 규칙은 [Main 구현](#main-구현)에 있습니다.

## Renderer에서 쓰기

### API 모양

`createRendererApi<B>()`는 Main과 연결을 확인한 뒤 API 객체를 돌려줍니다. 연결 확인이 실패하면 `RemoteError("INTERNAL")`로 reject합니다.

호출 경로는 `api.<도메인 경로>.rpc|state|event.<operation>`입니다.

- `api.device.rpc.connect()`: RPC
- `api.device.state.connection`: State(`RemoteState<T>`)
- `api.device.event.data`: Event(`Observable<T>`)

도메인은 중첩할 수 있습니다. `{ device: { serial: { rpc: { open(): void } } } }`는 `api.device.serial.rpc.open()`이 됩니다. 도메인에 없는 카테고리는 API에도 없습니다.

이름 규칙은 `createBridgeServer`가 생성 시점에 검사하고, 어기면 `TypeError`를 던집니다.

- operation 이름과 도메인 키에는 `/`를 쓸 수 없습니다(`{ "device/serial": ... }`는 거부). 묶음은 중첩 도메인으로 표현합니다.
- 도메인 경로에 `rpc`·`state`·`event`를 이름으로 쓸 수 없습니다.
- 최상위 도메인 이름 `dispose`는 예약입니다. 하위 도메인이나 operation 이름으로는 쓸 수 있습니다(`api.device.rpc.dispose`).
- 빈 이름, `.`이 든 이름, `__proto__`·`prototype`·`constructor`·`then`은 어느 위치에도 쓸 수 없습니다.

API 객체는 동결돼 있고 선언되지 않은 경로는 `undefined`입니다. 근거는 [ADR 0007](../../docs/adr/0007-hierarchical-renderer-api.md), 세부는 [설계 02. Renderer API](../../docs/design/02-renderer-api.md)에 있습니다.

### RPC

RPC는 [값 규칙](#값-규칙과-크기-한도)을 만족하는 입력값 하나를 받고 `Promise`를 돌려줍니다. 취소와 제한 시간은 두 번째 인자 `CallOptions`로 넘깁니다.

```ts
const controller = new AbortController();
const result = await api.device.rpc.connect(undefined, {
  signal: controller.signal, // abort하면 RemoteError("CANCELLED")
  timeoutMs: 5_000, // 기본 30초. Infinity로 끌 수 있습니다.
});
```

응답, 취소, 제한 시간 중 먼저 일어난 하나만 결과가 됩니다. 실패는 `code`를 가진 `RemoteError`로 옵니다([오류 코드](#오류-코드)).

`DEADLINE_EXCEEDED`는 두 곳에서 옵니다. Renderer의 `timeoutMs`와 Main의 `resourceLimits.maxRpcDurationMs`입니다. 먼저 확정된 쪽이 결과입니다.

### State

`RemoteState<T>`는 읽기 전용 `Observable<T>`이고 `.snapshot`으로 현재 상태를 동기로 읽습니다.

| `snapshot.status` | 뜻                                                               | `value` |
| ----------------- | ---------------------------------------------------------------- | ------- |
| `uninitialized`   | 값이 없고 원격 구독도 없습니다                                   | 없음    |
| `connecting`      | 첫 구독자가 원격 구독을 열었고 첫 값을 기다립니다                | 없음    |
| `current`         | Main의 현재값을 받았습니다                                       | 있음    |
| `stale`           | 값을 받은 뒤 원격 구독이 끝났습니다(마지막 구독 해제, 원격 종료) | 있음    |

- 원격 구독은 첫 로컬 구독자가 열고 마지막 로컬 구독자가 닫습니다. 그 사이 같은 API 객체의 로컬 구독자는 원격 구독 하나를 공유합니다.
- 새 원격 구독을 열면 이전 `stale` 값은 버립니다. 첫 값 전에 끝나면 `uninitialized`로 돌아갑니다. 옛 값을 새 구독자에게 재생하지 않습니다.
- `current` 값은 구독자에게 알리기 전에 `snapshot`에 반영됩니다.
- 원격 구독이 열려 있을 때 늦게 합류한 구독자는 `subscribe()` 호출 안에서 현재값을 동기로 한 번 받습니다. `undefined`도 값입니다. `connecting` 중에 합류하면 첫 값을 기다립니다.

```ts
const snapshot = api.device.state.connection.snapshot;
if (snapshot.status === "current") console.log(snapshot.value.connected);
```

화면 프레임워크에 연결할 때는 [프레임워크 연동](#프레임워크-연동)의 `snapshotStore`를 씁니다.

### Event

Event 구독은 Main이 구독을 확인한 뒤의 값만 받습니다. 재생하지 않고, 확인 뒤로는 순서를 지키며, 값마다 최대 한 번 전달합니다. 같은 API 객체에서 같은 Event를 구독하는 로컬 구독자는 원격 구독 하나를 공유합니다.

Event를 직접 구독할 때는 `error`도 넘기세요. `next`만 넘기면 원격 종료가 rxjs 미처리 오류(`Uncaught RemoteError`)로 보고되고, 구독은 닫힌 채 이후 이벤트를 받지 못합니다.

```ts
api.relay.event.fault.subscribe({
  next: (fault) => console.log(fault.code),
  error: (error: unknown) => console.error(error), // 구독 종료 원인
});
```

### 오류 코드

RPC와 구독의 실패는 `RemoteError`(`code`, `message`, 선택적 `details`)로 옵니다. 라이브러리가 만드는 코드는 아래 9개입니다. 재시도 열은 같은 요청을 다시 보낼 가치가 있는지입니다.

| 코드                 | 뜻과 주요 원인                                                                                                                                                    | RPC | 구독     | 재시도                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- | ------------------------------------------------- |
| `INVALID_ARGUMENT`   | 입력이 크기 한도나 입력 스키마를 어겼습니다. `timeoutMs`가 잘못됐습니다                                                                                           | O   | X        | 없음. 같은 입력은 같은 결과입니다                 |
| `NOT_FOUND`          | 등록되지 않은 operation입니다                                                                                                                                     | O   | O        | 없음                                              |
| `FORBIDDEN`          | `authorize`가 거부했거나, 허용되지 않은 창·연결이 해제된 창에서 보냈습니다                                                                                        | O   | O        | 없음. 권한 판정이 바뀌어야 합니다                 |
| `CANCELLED`          | 결과 전에 끝났습니다. `signal` abort, `api.dispose()`, Main 세션 종료                                                                                             | O   | O        | 없음. 세션 종료는 같은 문서에서 복구되지 않습니다 |
| `DEADLINE_EXCEEDED`  | `timeoutMs` 또는 Main `maxRpcDurationMs`를 넘었습니다                                                                                                             | O   | X        | 있음. 멱등 작업만, 지연을 두고                    |
| `RESOURCE_EXHAUSTED` | 세션의 동시 RPC·구독 한도를 넘었습니다                                                                                                                            | O   | O        | 있음. 진행 중인 요청이 끝난 뒤                    |
| `VERSION_MISMATCH`   | 요청의 프로토콜 버전이 다릅니다. 직접 만든 transport가 잘못된 버전을 보낼 때 옵니다. 배포 버전이 어긋나면 `createRendererApi`가 먼저 `INTERNAL`로 실패합니다      | O   | X        | 없음. 배포가 어긋났습니다                         |
| `INTERNAL`           | Main 쪽 결함입니다. 선언하지 않은 handler 예외, 출력 검증 실패, `authorize` 예외·reject, source 오류. 전송 실패(값 규칙을 어긴 입력을 preload가 거부한 경우 포함) | O   | O        | Main 쪽 원인이면 없음                             |
| `STREAM_OVERFLOW`    | Event buffer가 가득 찼습니다(overflow 정책 `"error"`). 대기 중인 값을 모두 전달한 뒤 옵니다                                                                       | X   | O(Event) | 다시 구독할 수 있지만 빠진 값은 복구되지 않습니다 |

이 밖에 `options.errors`로 허용한 도메인 코드가 handler에서 그대로 옵니다([허용 에러 코드](#허용-에러-코드)). 코드별 메시지와 판정 순서는 [설계 08. Payload와 오류 모델](../../docs/design/08-payload-and-errors.md)의 "오류 코드" 절에 있습니다.

### 구독 종료 원인

State·Event 구독이 어떻게 끝나는지 정리합니다. 끝난 구독은 스스로 다시 구독하지 않습니다.

| 원인                                                                                                          | 구독자가 받는 것                                                                             |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 구독자가 `unsubscribe()`                                                                                      | 없음                                                                                         |
| Main source가 complete                                                                                        | `complete`                                                                                   |
| `api.dispose()`                                                                                               | `complete`                                                                                   |
| Main 세션 종료(`attach` 해제, `server.dispose()`, bind `dispose()`)                                           | `error`: `CANCELLED "Bridge session ended."`                                                 |
| `attach` 해제, `server.dispose()`, bind `dispose()` 뒤의 새 구독                                              | 구독 확인 직후 `error`: `FORBIDDEN "Bridge sender is not authorized."`(RPC 거부와 같은 문구) |
| `authorize` 거부                                                                                              | `error`: `FORBIDDEN`                                                                         |
| 세션 구독 한도 초과                                                                                           | `error`: `RESOURCE_EXHAUSTED`                                                                |
| Event buffer 초과(overflow 정책 `"error"`)                                                                    | `error`: `STREAM_OVERFLOW`                                                                   |
| Main source error, 출력 검증 실패, `authorize` 예외·reject                                                    | `error`: `INTERNAL`. source 오류의 `code`는 전달되지 않습니다                                |
| 창 reload·탐색, renderer process 종료, 창 파괴                                                                | 없음. 그 문서 자체가 사라집니다                                                              |
| 같은 창에서 다른 연결 ID로 다시 연결(예: 한 문서에서 같은 namespace로 `exposeBridgeInMainWorld`를 두 번 호출) | 없음. 옛 API의 `RemoteState`는 마지막 값을 유지합니다                                        |

- Main 세션 종료는 `authorize` 판정을 기다리던 구독에도 옵니다. 아직 전달하지 않은 값은 버립니다.
- `RemoteState`는 구독이 끝나면 값이 있었으면 `stale`, 없었으면 `uninitialized`가 됩니다.
- Main에서 source를 바꿔야 한다면 source를 끝내지 말고 [State source 교체](#state-source-교체)처럼 평탄화합니다.

세션 종료 통지의 세부 규칙은 [설계 04. 문서 세션](../../docs/design/04-document-session.md)과 [ADR 0020](../../docs/adr/0020-stream-terminal-on-retire.md)에 있습니다.

### `api.dispose()`

`api.dispose()`는 이 API 객체를 되돌릴 수 없게 종료합니다. `api[Symbol.dispose]`와 같은 함수입니다.

- 진행 중인 RPC는 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 즉시 reject됩니다.
- 활성 State·Event 구독은 Main에 구독 해제를 보낸 뒤 `complete()`로 끝납니다(`error`가 아닙니다).
- 종료 뒤의 RPC·subscribe는 Main에 보내지 않고 같은 `CANCELLED`로 끝납니다.
- 다시 호출하면 아무 일도 하지 않습니다.

창이 떠 있는 동안에는 부를 필요가 없습니다. 창을 닫거나 reload하면 Main이 그 문서의 자원을 회수합니다. SPA 라우팅으로 화면을 벗어나며 그 화면의 호출과 구독을 한꺼번에 끊을 때 씁니다. 근거는 [ADR 0006](../../docs/adr/0006-shutdown-contract.md)과 [ADR 0013](../../docs/adr/0013-wiring-defaults.md)에 있습니다.

## 프레임워크 연동

### React

`snapshotStore(state: RemoteState<T>): RemoteStateStore<T>`는 `RemoteState`를 외부 store 계약(`subscribe(onChange) → unsubscribe`, `getSnapshot()`)으로 바꿉니다. 같은 `state`로 다시 부르면 같은 store(같은 `subscribe`·`getSnapshot` 참조)를 돌려줍니다.

React는 `useSyncExternalStore`에 그대로 연결합니다.

```ts
import { useSyncExternalStore } from "react";

import {
  snapshotStore,
  type RemoteState,
  type RemoteStateSnapshot,
} from "@cp949/rx-bridge-electron/renderer";

/** Converts a bridge State stream into React's external-store contract. */
export function useRemoteState<T>(
  state: RemoteState<T>,
): RemoteStateSnapshot<T> {
  const store = snapshotStore(state);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
```

세 번째 인자 `getServerSnapshot`은 생략합니다. Electron renderer에는 SSR이 없습니다.

- store의 listener들은 `state` 구독 하나를 공유합니다. 마지막 listener가 나가면 구독을 해제합니다.
- 원격 `complete`·`error` 뒤에는 `stale`·`uninitialized`에서 멈추고 다시 구독하지 않습니다. 다시 구독하려면 컴포넌트를 remount하세요. 남아 있던 listener도 새 값을 받습니다.
- 종료 원인(`RemoteError`)은 store로 알 수 없습니다. 필요하면 `state.subscribe({ error })`로 직접 구독하세요.

다른 프레임워크도 같은 `subscribe`·`getSnapshot`을 각자의 store 연결 방식에 넘기면 됩니다. 알림 규칙의 세부는 [설계 07. Renderer 스트림과 State](../../docs/design/07-renderer-streams.md)와 [ADR 0024](../../docs/adr/0024-remote-state-snapshot-store.md)에 있습니다.

### Event·RPC 직접 사용

Event와 RPC에는 adapter가 없습니다. Event는 현재값이 없어 누적 방식(목록 추가, 개수, 마지막 값)이 화면마다 다르고, RPC는 `Promise`입니다.

Event를 구독할 때는 `error`를 넘기고 unmount 때 해제합니다. State를 `snapshotStore` 없이 직접 구독할 때(`pipe(sampleTime(...))` 등)도 같습니다.

```tsx
import { useEffect, useState } from "react";

import { RemoteError } from "@cp949/rx-bridge-electron/renderer";

function errorText(error: unknown): string {
  return error instanceof RemoteError
    ? `${error.code}: ${error.message}`
    : String(error);
}

function FaultView() {
  const [fault, setFault] = useState("");
  const [streamError, setStreamError] = useState("");
  useEffect(() => {
    const subscription = api.relay.event.fault.subscribe({
      next: (value) => setFault(`${value.code}: ${value.message}`),
      error: (error: unknown) => setStreamError(errorText(error)),
    });
    return () => subscription.unsubscribe();
  }, []);
  // ...
}
```

RPC는 호출마다 `AbortController`를 만들고 unmount 때 진행 중인 호출을 모두 abort하세요. `signal`을 넘기지 않으면 화면을 떠나도 응답이나 `timeoutMs`까지 Main의 동시 RPC 한도 한 칸을 차지합니다. handler가 `signal`을 무시하면 handler가 끝날 때까지 차지합니다.

```tsx
const controllers = useRef(new Set<AbortController>());
useEffect(() => () => controllers.current.forEach((c) => c.abort()), []);

const invoke = async (call: (signal: AbortSignal) => Promise<unknown>) => {
  const controller = new AbortController();
  controllers.current.add(controller);
  try {
    await call(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) setOperationError(errorText(error));
  } finally {
    controllers.current.delete(controller);
  }
};

// <button onClick={() => void invoke((signal) => api.relay.rpc.turnOn(undefined, { signal }))}>
```

### TanStack Query

RPC는 `Promise`를 돌려주므로 `queryFn`·`mutationFn`에 그대로 넣습니다. 이 패키지와 demo는 TanStack Query에 의존하지 않습니다. 아래 예제는 문서로만 제공합니다.

```ts
// bridge/contract.ts
export type Note = { readonly id: string; readonly title: string };

export type AppBridge = {
  notes: {
    rpc: {
      list(input: { readonly folder: string }): readonly Note[];
      save(input: Note): Note;
    };
  };
};
```

```ts
// Renderer
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { RemoteError } from "@cp949/rx-bridge-electron/renderer";
import { api } from "./bridge.js"; // createRendererApi<AppBridge>() 결과
import type { Note } from "./bridge/contract.js";

const RETRYABLE_CODES = new Set(["RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED"]);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        failureCount < 3 &&
        error instanceof RemoteError &&
        RETRYABLE_CODES.has(error.code),
    },
  },
});

export function useNotes(folder: string) {
  return useQuery({
    queryKey: ["notes", "list", folder],
    queryFn: ({ signal }) => api.notes.rpc.list({ folder }, { signal }),
  });
}

export function useSaveNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (note: Note) => api.notes.rpc.save(note),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notes"] }),
  });
}
```

- **`signal` 전달.** TanStack이 query를 취소하면(`cancelQueries`, 결과를 기다리는 observer 없이 unmount 등) RPC가 `RemoteError("CANCELLED")`로 끝나고 Main handler의 `context.signal`도 abort됩니다. query는 error가 되지 않고 이전 상태로 돌아갑니다.
- **`queryKey`.** 입력값을 key에 넣습니다. TanStack의 기본 key hash는 `JSON.stringify`라 일반 객체·배열·문자열·유한한 수에는 그대로 쓸 수 있습니다. 입력에 `bigint`(throw)나 `NaN`·`Infinity`(`null`로 합쳐짐)가 있으면 `queryKeyHashFn`을 따로 둡니다.
- **retry 판정.** TanStack query의 기본값은 어떤 오류든 3회 재시도입니다. [오류 코드](#오류-코드) 표에서 재시도 가치가 있는 코드는 `RESOURCE_EXHAUSTED`와 `DEADLINE_EXCEEDED`뿐입니다. 도메인 코드, `api.dispose()` 뒤의 `CANCELLED`, `RemoteError`가 아닌 오류도 재시도하지 않습니다.
- **재시도 간격.** `timeoutMs`가 지나도 Main의 동시 RPC 한도 칸은 handler가 끝날 때 비워집니다([ADR 0015](../../docs/adr/0015-rpc-request-lifecycle.md)). `signal`을 무시하는 handler 뒤로 곧바로 재시도하면 `DEADLINE_EXCEEDED`가 `RESOURCE_EXHAUSTED`로 바뀔 수 있으므로 `retryDelay`를 0으로 두지 않습니다(기본값은 지수 backoff).
- **mutation.** TanStack mutation은 기본 재시도 0회이고 `mutationFn`에 `signal`을 주지 않습니다. 재시도를 켜지 않습니다. `DEADLINE_EXCEEDED`는 handler가 부작용을 이미 냈는지 알려주지 않습니다. 취소가 필요하면 직접 만든 `AbortController`의 `signal`을 `CallOptions`로 넘깁니다.

검증 범위: 위 예제는 `@tanstack/react-query` 5.103.2로 타입 검사했습니다. `@tanstack/query-core` 5.103.2의 `QueryClient`와 `createLoopbackTransport`([테스트](#테스트))로 실제 server에 대해 성공·취소·코드별 재시도 횟수를 1회 실행해 확인했습니다. 이 저장소의 test와 CI에는 포함되지 않으므로 TanStack Query 버전이 바뀌면 다시 확인해야 합니다.

## Main 구현

### `impl`과 `authorize`

`impl: BridgeImpl<AppBridge>`는 계약의 모든 도메인·operation에 대응하는 handler와 source를 가진 일반 객체입니다.

| 카테고리 | `impl` 값                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------ |
| `rpc`    | `(input, context: BridgeContext) => O \| Promise<O>`                                             |
| `state`  | `currentValueSource(source)`. `source`는 `getValue()`를 가진 `Observable`(예: `BehaviorSubject`) |
| `event`  | `Observable<T>`, `broadcastEvent(...)`, `scopedEvent(...)`                                       |

계약과 어긋나면(누락, 초과, handler·source 형태 오류) 컴파일에 실패합니다. 초과 operation 검사는 TypeScript의 excess property check라 객체 리터럴에만 적용됩니다. 다른 변수를 거쳐 넘긴 객체의 초과 operation은 타입 검사를 통과하고 Renderer에 노출됩니다(Renderer 타입에는 없습니다). 근거는 [ADR 0012](../../docs/adr/0012-lightweight-type-contract.md)에 있습니다.

타입을 우회한 값(`as any` 등)도 `createBridgeServer`가 형태를 검사합니다. handler가 함수인지, state source가 `getValue`를 갖는지 등을 보고, 어기면 `TypeError`를 던집니다. 세부는 [설계 01. 계약과 등록](../../docs/design/01-contract.md)에 있습니다.

`authorize(context, operation)`는 등록된 operation의 RPC 호출과 구독 요청마다 불리는 인가 콜백입니다. `boolean` 또는 `Promise<boolean>`을 돌려줍니다. 생략하면 전부 허용합니다. `operation`은 operation key를 미리 분해한 동결 객체 `BridgeOperation`입니다.

| 필드        | 예(`rpc:admin/users/remove`) | 설명                                                           |
| ----------- | ---------------------------- | -------------------------------------------------------------- |
| `key`       | `"rpc:admin/users/remove"`   | operation key(`카테고리:도메인 경로/operation`). 비교에 씁니다 |
| `category`  | `"rpc"`                      | `"rpc" \| "state" \| "event"`                                  |
| `domain`    | `["admin", "users"]`         | 도메인 경로 배열                                               |
| `operation` | `"remove"`                   | operation 이름                                                 |

`BridgeOperation`·`OperationCategory` 타입은 `@cp949/rx-bridge-electron/main`에서 가져옵니다. 근거는 [ADR 0018](../../docs/adr/0018-authorize-structured-operation.md)에 있습니다.

### 스키마

도메인 스키마는 선택이며 operation 단위로 필요한 것만 둡니다. [시작하기](#시작하기) 예제는 스키마 없이 동작합니다. 값 규칙과 크기 한도 검사([값 규칙과 크기 한도](#값-규칙과-크기-한도))는 스키마가 없어도 항상 적용됩니다.

스키마는 `options.schemas`에 둡니다. 타입 `SchemasFor<AppBridge>`가 경로 오타와 스키마 출력 타입 불일치를 컴파일 오류로 잡습니다. 스키마는 `Schema<T>`(`parse(value: unknown): T`) 구조면 되고 zod에 의존하지 않습니다.

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

- RPC는 `{ input?: Schema<I>; output?: Schema<O> }`, State·Event는 `Schema<T>` 하나입니다. 입력이 없는 RPC에는 `input` 항목이 없습니다.
- 스키마가 없는 항목은 도메인 검증 없이 통과합니다.
- 입력 스키마가 실패하면 `INVALID_ARGUMENT`, 출력 스키마가 실패하면 `INTERNAL`입니다.

처리 순서는 [설계 05. RPC](../../docs/design/05-rpc.md)에 있습니다.

스키마를 다른 파일에 두려면 `satisfies SchemasFor<AppBridge>`로 타입 검사를 유지합니다. 여러 operation의 스키마를 조합하는 예는 `packages/rx-bridge-electron/test/main/impl-schemas-fixture.ts`와 `apps/demo/src/main/schemas.ts`에 있습니다.

```ts
// main/schemas.ts
export const schemas = {
  device: { state: { connection: connectionSchema } },
} satisfies SchemasFor<AppBridge>;

// main/index.ts
import { schemas } from "./schemas.js";
const server = createBridgeServer(impl, { schemas });
```

스키마는 Main에만 둡니다. Renderer는 계약 타입만 참조하므로 스키마가 Renderer 번들에 들어가지 않습니다.

### 허용 에러 코드

`options.errors: ErrorsFor<AppBridge>`는 RPC operation마다 handler가 보낼 수 있는 도메인 에러 코드 목록(`readonly string[]`)입니다.

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

- handler가 `code`·`message`(선택적으로 값 규칙을 만족하는 `details`)를 가진 값을 던지고, `code`가 목록에 있으면 Renderer는 그 코드를 받습니다.
- 목록에 없거나 형태가 어긋나면 `INTERNAL`로 바뀝니다. `message`나 `details`가 [크기 한도](#값-규칙과-크기-한도)를 넘어도 `INTERNAL`입니다.

### Event buffer

Event 값은 Renderer가 받을 때까지 Main의 buffer에서 기다립니다. buffer 용량과 overflow 정책은 Main에서 source를 만들 때 옵션으로 줍니다. 생략하면 `capacity: 100`, `overflow: "error"`입니다.

```ts
import { Subject } from "rxjs";
import { broadcastEvent, scopedEvent } from "@cp949/rx-bridge-electron/main";

const data$ = new Subject<{ readonly text: string }>();

// 모든 창·세션의 구독이 이 source 구독 하나를 공유합니다.
const dataEvent = broadcastEvent(data$, {
  buffer: { capacity: 256, overflow: "drop-oldest" },
});

// 구독마다 factory를 불러 별도 source를 만듭니다(context별로 다른 값을 흘려보낼 때).
const scopedDataEvent = scopedEvent(
  (context) => data$, // 또는 context.windowRole에 따라 다른 Observable
  { buffer: { capacity: 64, overflow: "error" } },
);
```

| `overflow`      | buffer가 가득 찼을 때                                             |
| --------------- | ----------------------------------------------------------------- |
| `"error"`       | 대기 중인 값을 모두 전달한 뒤 구독을 `STREAM_OVERFLOW`로 끝냅니다 |
| `"drop-oldest"` | 가장 오래된 값을 버립니다                                         |
| `"drop-newest"` | 새 값을 버립니다                                                  |

- plain `Observable<T>`을 그대로 impl에 두면 기본값을 씁니다.
- 잘못된 `capacity`·`overflow`나 source 모양은 `createBridgeServer`가 `TypeError`로 거부합니다. helper 없이 직접 쓴 source 객체도 같습니다.
- buffer 옵션 객체나 source 반환 타입을 따로 선언할 때는 `/main`의 `EventSourceBuffer`·`OverflowPolicy`·`EventSource<T>`·`BroadcastEventSource<T>`·`ScopedEventSource<T>`를 씁니다.

### State source 교체

Main State source가 complete하거나 error를 내면 Renderer의 원격 구독이 끝납니다. 구독자는 `stale`(또는 `uninitialized`)에서 멈추고 스스로 다시 구독하지 않습니다.

source를 바꿔야 하면(장치 재연결 등) source 자체를 끝내지 마세요. 오래 사는 `BehaviorSubject`에 `switchMap`으로 평탄화해 `next`만 전달합니다. 안쪽 error는 `catchError`로 값으로 바꿉니다. 이 `BehaviorSubject`는 complete하지 않습니다.

```ts
import { BehaviorSubject, catchError, of, switchMap } from "rxjs";
import { currentValueSource } from "@cp949/rx-bridge-electron/main";

const connection = new BehaviorSubject({ connected: false });
devices$
  .pipe(
    switchMap((device) =>
      device.connection$.pipe(catchError(() => of({ connected: false }))),
    ),
  )
  .subscribe((value) => connection.next(value));

const source = currentValueSource(connection);
```

## Electron 연결

Main·preload·Renderer를 Electron IPC로 잇는 연결 설정입니다. [시작하기](#시작하기)의 "Electron IPC에 연결", "Preload", "브리지에 연결" 블록이 여기에 해당합니다.

### 보안 설정

`bindElectronBridge({ ipcMain?, server, namespace?, allowedOrigins })`로 서버를 IPC에 연결합니다. 허용할 최상위 창마다 `attach(webContents, role?)`을 호출합니다.

- `allowedOrigins`는 생략할 수 없습니다. origin 검증이 보안 경계이기 때문입니다.
- Main을 종료하기 전에 `bridge.dispose()`를 호출합니다.
- `dispose()` 뒤의 서버와 bind는 다시 쓸 수 없습니다. 다시 연결하려면 `createBridgeServer`와 `bindElectronBridge`를 새로 만듭니다. 같은 namespace로 새로 만든 bind는 dispose된 bind의 IPC 연결을 넘겨받습니다. dispose되지 않은 bind가 있는 채 같은 namespace로 다시 만들면 오류가 납니다.

창은 다음 설정으로 만드세요: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, 고정 preload, 탐색과 창 생성 제한, 명시적 신뢰 origin 목록. Renderer 코드는 preload가 노출한 동결 transport만 받고 `ipcRenderer`나 채널 이름에 접근하지 못합니다([ADR 0001](../../docs/adr/0001-fixed-preload-capability.md)).

### 기본값

| 옵션                                        | 위치                                                            | 생략 시                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`                                 | `bindElectronBridge`, `exposeBridgeInMainWorld`                 | `"default"`(Main·preload 공통 상수). 채널은 `rx-bridge-electron:v1:default:*`가 됩니다.                                                         |
| `role`                                      | `attach(contents, role?)`                                       | `"default"`. `authorize`의 `context.windowRole`로 전달되므로 역할로 인가를 나누는 앱은 명시합니다.                                              |
| `globalName`                                | `exposeBridgeInMainWorld`, `createRendererApi`가 읽는 전역 이름 | `"rxBridge"`(`window.rxBridge`)                                                                                                                 |
| `ipcMain` / `contextBridge` / `ipcRenderer` | `bindElectronBridge` / `exposeBridgeInMainWorld`                | 호출 시점에 `import * as electron from "electron"`으로 해석(`electron.ipcMain` 등). 둘 다 없으면(Electron 밖) `TypeError`. 주입값이 우선합니다. |
| `transport`                                 | `createRendererApi<B>(options?)`                                | `globalThis.rxBridge`를 읽습니다. 없거나 transport 형태가 아니면 `rxBridge`·`exposeBridgeInMainWorld`를 언급하는 `TypeError`.                   |

기본값과 해석 순서의 근거는 [ADR 0013](../../docs/adr/0013-wiring-defaults.md)에 있습니다.

### 명시 형태

기본값을 그대로 쓰면 [시작하기](#시작하기) 예제로 충분합니다. 아래는 명시해야 하는 경우입니다.

**여러 namespace(다중 브리지).** 서로 다른 도메인을 별도 채널로 격리하려면 `namespace`를 각각 지정합니다. namespace는 채널 자체를 나눕니다. 한 브리지 안에서 창마다 `role`로 인가를 나누는 것(예: 데모의 `main`/`monitor`)과는 다릅니다.

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

**globalName을 바꾼 경우.** `createRendererApi`는 기본 이름이 아닌 전역을 찾지 못합니다. 그 전역을 직접 읽어 `transport`로 넘기고, 전역 타입을 `declare global`로 선언합니다. 기본 이름 `Window.rxBridge`는 라이브러리가 이미 선언합니다.

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

**테스트에서 electron과 transport를 주입하는 경우.** 유닛 테스트는 Electron 밖에서 돌아 `electron.ipcMain` 등을 얻을 수 없습니다. Main·preload 테스트는 이 값들을 주입하고, Renderer 테스트는 mock `BridgeTransport`를 넘깁니다. 패키지 테스트의 `FakeIpcMain`·`FakeContextBridge`·`FakeIpcRenderer`·`FakeTransport`가 같은 형태입니다.

실제 서버를 거치는 테스트는 [테스트](#테스트)의 loopback transport가 더 간단합니다.

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

## 한도와 진단

### 값 규칙과 크기 한도

Main은 RPC 입력을 handler 전에, RPC 출력을 전송 전에, State·Event 값을 전달 전에 검사합니다. 스키마 유무와 무관하게 모든 operation에 적용됩니다.

- 허용: `undefined`, `null`, 원시 값, 배열, 일반 객체 트리.
- 거부: 순환 참조, 함수, symbol, 사용자 정의 prototype(class 인스턴스, `Date`, `Map` 등), typed array, transferable.
- RPC 입력이 크기 한도를 넘으면 `INVALID_ARGUMENT`입니다. 값 규칙을 어긴 입력은 preload가 보내기 전에 거부하므로 `INTERNAL "RPC transport failed."`가 됩니다.
- RPC 출력과 State·Event 값이 어기면 `INTERNAL`입니다.

| 한도(`payloadLimits` 필드) | 기본값                        |
| -------------------------- | ----------------------------- |
| `maxDepth`                 | 32                            |
| `maxEntries`               | 10,000                        |
| `maxStringBytes`           | 문자열당 UTF-8 1,000,000 byte |
| `maxTotalBytes`            | 16 MiB                        |

```ts
import {
  createBridgeServer,
  DEFAULT_PAYLOAD_LIMITS,
} from "@cp949/rx-bridge-electron/main";

const server = createBridgeServer(impl, {
  payloadLimits: {
    maxStringBytes: 4_000_000, // 생략한 필드는 기본값
    maxTotalBytes: DEFAULT_PAYLOAD_LIMITS.maxTotalBytes * 2,
  },
});
```

- `maxTotalBytes`는 값을 순회하며 근사 계산한 크기입니다. 실제 V8 structured clone 크기와 다를 수 있습니다.
- 필드를 생략하면 기본값을 씁니다. 필드에 `undefined`를 넣으면 `createBridgeServer`가 `TypeError`를 던집니다.
- 전체 크기 한도를 사실상 끄려면 `maxTotalBytes: Number.MAX_SAFE_INTEGER`를 씁니다.
- 한도는 Main 서버가 강제합니다. 기본값은 `DEFAULT_PAYLOAD_LIMITS`(동결)로 읽습니다.

검사 단계별 결과는 [설계 08. Payload와 오류 모델](../../docs/design/08-payload-and-errors.md)에 있습니다.

### 세션 자원 한도

Main은 세션마다 자원을 제한합니다. 세션은 `attach`한 창에서 `createRendererApi`로 연결한 현재 문서 하나입니다. reload나 탐색으로 문서가 바뀌면 새 세션이 됩니다.

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

- 지정하지 않은 필드는 기본값을 씁니다.
- 동시 RPC·구독 수를 넘으면 `RESOURCE_EXHAUSTED`입니다.
- `maxRpcDurationMs`를 넘으면 `DEADLINE_EXCEEDED`로 응답하고 handler의 `context.signal`을 abort합니다.
- 한도는 세션별로 격리됩니다. `signal`을 무시하는 handler는 자기 세션의 동시 RPC 한도만 계속 차지합니다.
- `maxRetiredClientsPerWebContents`는 창마다 기억하는 종료된 Renderer 연결 ID 수입니다. 종료된 연결의 재사용을 거부하는 데 씁니다.

근거는 [ADR 0009](../../docs/adr/0009-session-resource-limits.md), 세부는 [설계 09. 세션 자원 한도](../../docs/design/09-resource-limits.md)에 있습니다.

### Main 진단

`createBridgeServer`의 `diagnostics` 옵션에 `DiagnosticsSink`를 주면 닫힌 타입의 진단 이벤트를 받습니다.

- RPC 완료(성공·실패 `outcome`)·취소·Main deadline 만료
- 출력 검증 실패
- Event 대기 깊이와 버림
- 보안·입력·자원 한도 거부(`rejected`, `RejectReason` 11개)
- 세션·구독의 생성과 해제
- State·Event source teardown 예외(`upstream-teardown-failed`. 예외는 bridge가 삼키고 정리를 마칩니다)

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

- 식별자는 operation key만 실립니다. 그 밖의 필드는 사유 코드, 소요 시간, 대기 깊이, 버린 수 같은 수치입니다. 자격 증명, payload, origin, 요청·구독·연결 ID, `Error` 객체는 싣지 않습니다.
- sink가 없거나 `record`가 예외를 던져도 bridge 동작은 같습니다. 지정하지 않으면 콘솔 출력도 없습니다.

이벤트 종류와 사유별 판정 지점은 [ADR 0010](../../docs/adr/0010-operational-diagnostics.md)과 [설계 11. 진단](../../docs/design/11-diagnostics.md)에 있습니다.

### Renderer 진단

`createRendererApi<B>(options)`의 `diagnostics` 옵션에 `RendererDiagnosticsSink`를 주면 Renderer 쪽 이벤트 6종을 받습니다.

| 이벤트                | 기록 시점                                   |
| --------------------- | ------------------------------------------- |
| `rpc-settled`         | RPC 결과 확정. 호출마다 정확히 1회          |
| `subscription-opened` | 원격 구독 시작                              |
| `subscription-closed` | 원격 구독 종료. `subscription-opened`와 1쌍 |
| `handshake-failed`    | `createRendererApi`의 연결 확인 실패        |
| `message-dropped`     | 받은 스트림 메시지를 버림                   |
| `transport-failed`    | 취소·구독 해제·수신 확인 전송 실패를 삼킴   |

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

- 식별자는 operation key만 실립니다. `RemoteError.code`는 `cause: "remote-error"`일 때만 실립니다. 오류 객체·메시지·payload·ID는 싣지 않습니다.
- sink가 없거나 `record`가 예외를 던져도 API 동작은 같습니다. 지정하지 않으면 콘솔 출력도 없습니다.
- 스냅샷 조회는 없습니다. 활성 구독 수는 `subscription-opened`/`subscription-closed` 쌍으로 셉니다.

원인 판정 전체 목록은 [ADR 0022](../../docs/adr/0022-renderer-diagnostics.md)와 [설계 11. 진단](../../docs/design/11-diagnostics.md)에 있습니다.

## 테스트

`@cp949/rx-bridge-electron/testing`의 `createLoopbackTransport`는 실제 `server`와 실제 `createRendererApi`를 preload·IPC 없이 잇습니다. 메시지 형식을 손으로 만들 필요가 없고, 실제 server를 거치므로 형식이 바뀌어도 test는 그대로입니다.

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

`createLoopbackTransport(server, options?)`는 `BridgeTransport & { dispose(): void }`를 돌려줍니다. `server`는 `createBridgeServer`로 만든 것을 넘깁니다.

| 옵션       | 기본값                                                                           | 설명                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sender`   | `{ webContentsId: 1, frameId: 1, isMainFrame: true, origin: "loopback://test" }` | `Partial<SenderIdentity>`, 지정한 필드만 덮어씁니다. 다중 창은 `webContentsId`(필요하면 `frameId`도)를 다르게 준 transport를 여러 개 만듭니다. |
| `clientId` | `"loopback-client"`                                                              | 같은 `webContentsId`에서 이미 종료된 `clientId`는 다시 쓸 수 없습니다. 동시에 붙일 transport는 `sender.webContentsId`를 다르게 줍니다.         |
| `role`     | `"default"`                                                                      | `server.attach`에 넘기는 role. `authorize`의 `context.windowRole`로 전달됩니다.                                                                |

- 요청·응답과 스트림 메시지는 모두 `structuredClone`을 거칩니다. 참조를 공유하지 않습니다.
- 메시지 검사는 preload와 같은 함수를 써서 같은 입력에서 같은 지점에서 실패합니다.
- `dispose()`는 연결 해제만 합니다. `server`는 살아 있어 새 loopback transport를 계속 만들 수 있습니다.
- `dispose()` 뒤 그 transport의 구독은 종료 통지를 받지 않고 `RemoteState`는 `current`로 남습니다. 먼저 `api.dispose()`를 부르세요.
- 같은 `webContentsId`로 새 loopback transport를 만들면 앞 transport의 구독은 `CANCELLED "Bridge session ended."`로 끝납니다.

운영 코드에서는 쓰지 않습니다. Renderer는 고정 preload transport만 받아야 합니다([ADR 0001](../../docs/adr/0001-fixed-preload-capability.md)). 전달 시점과 예외 처리의 세부는 [ADR 0017](../../docs/adr/0017-loopback-test-transport.md)과 [설계 03. Transport와 연결 설정](../../docs/design/03-transport-and-wiring.md)에 있습니다.

## 범위 밖

- 대용량 바이너리 전송과 지속적인 고속 스트림. 필요하면 이 API에 원시 IPC를 노출하지 말고 별도 MessagePort 어댑터 뒤에 구현합니다.
- Renderer 쪽 도메인 에러 코드 타입 추론. `ErrorsFor<B>`는 Main 옵션 타입입니다.
- 그 밖의 제외 항목은 [아키텍처 문서 "목적과 범위"](../../docs/architecture.md#목적과-범위)에 있습니다.
