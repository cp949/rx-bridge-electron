# rx-bridge-electron 아키텍처

이 문서는 현재 코드와 공개 README에서 확인되는 동작을 기록한다. 과거 설계 토론의 전체 이력은 포함하지 않으며, 구현이 바뀌면 코드와 함께 갱신한다.

## 목적과 범위

`@cp949/rx-bridge-electron`은 신뢰하는 로컬 Electron UI의 Main과 Renderer 사이에 타입 및 스키마 검증을 거치는 RPC, State, Event 통신을 제공한다. 원격 콘텐츠, 플러그인 권한, 범용 `webContents` 스트림 범위, 지속적인 고속 Event, 바이너리 전송은 현재 계약 범위가 아니다.

## 패키지 경계

| 진입점                               | 실행 위치     | 책임                                                                           |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------ |
| `@cp949/rx-bridge-electron/contract` | 모든 프로세스 | 계약 타입에서 파생하는 타입(`BridgeApi`/`BridgeImpl`/`SchemasFor`/`ErrorsFor`) |
| `@cp949/rx-bridge-electron/main`     | Electron Main | 서버 생성, 핸들러 등록, 권한 확인, 검증, 세션 및 스트림 관리                   |
| `@cp949/rx-bridge-electron/preload`  | preload       | 고정 IPC 채널 어댑터와 `contextBridge` 노출                                    |
| `@cp949/rx-bridge-electron/renderer` | Renderer      | 비동기 API, RPC 클라이언트, `RemoteState`, RxJS Event                          |
| `@cp949/rx-bridge-electron/testing`  | test 전용     | `createLoopbackTransport` — in-process `BridgeTransport` 두 번째 adapter       |

`src/contract/`는 `src/protocol/`에만 의존하고 `src/main/*`을 타입으로도 import하지 않는다(eslint `no-restricted-imports`가 강제한다). `BridgeImpl`이 참조하는 구현 측 타입(`BridgeContext`·`SenderIdentity`·`CurrentValueSource`·`EventSource`와 그 구성 타입)은 `contract/impl-types.ts`가 소유하고 `main`이 re-export한다 — 공개 export 이름과 진입점은 그대로다.

계약은 런타임 값이 아니라 순수 TS 타입 `B`다. handler, Electron 객체, 자격증명, Node API, 함수, Observable/Subject는 preload 경계를 건너지 않는다. Renderer에는 고정된 `BridgeTransport`만 노출하며 `ipcRenderer`, 임의 채널, raw Electron event를 공개하지 않는다.

`BridgeTransport`(`connect`·`invoke`·`cancel`·`control`·`onStreamMessage`)의 실제 adapter는 preload 하나다. `./testing`이 공개하는 `createLoopbackTransport(server, options?)`는 두 번째 adapter로, 호출자가 만든 `server`에 고정 `SenderIdentity`로 `attach`해 실제 server를 거치는 요청·응답·stream을 만든다 — preload와 같은 protocol 함수(`withEnvelope`, `parseRendererRpcRequest`·`parseRendererStreamCommand`·`parseHandshakeResponse`·`parseRpcResponse`·`parseStreamMessage`)로 envelope를 조립·검사하고 양방향 `structuredClone`을 거친다. 라이브러리 사용자의 test 전용이며 운영 export가 아니다 — `./main`을 타입으로만 참조하고 `electron`을 런타임에 불러오지 않는다. [ADR 0001](adr/0001-fixed-preload-capability.md)이 정한 "Renderer는 고정 preload transport만 노출한다" 원칙에 예외를 만들지 않는다. 근거는 [ADR 0017](adr/0017-loopback-test-transport.md)에 있다.

## 계약 형태와 등록

계약은 도메인들의 중첩 객체 타입이다. 각 도메인 노드는 `rpc`·`state`·`event` 중 있는 카테고리만 키로 가지며(ADR 0007 계층과 동일한 모양), 그 외 키는 하위 namespace로 재귀 처리한다. 계약 자체는 값을 갖지 않으므로 런타임 계약 조합·등록 함수가 없다.

Main은 `createBridgeServer<B>(impl: BridgeImpl<B>, options)` 하나로 서버를 만든다. `impl`은 계약이 선언한 모든 도메인·모든 operation에 대응하는 handler(rpc)/`CurrentValueSource`(state)/`EventSource`(event)를 가진 일반 객체이고, manifest는 이 `impl`의 키에서 생성한다. 계약과 구현의 일치(누락·초과 operation, handler·소스 타입)는 `B`와 `impl: BridgeImpl<B>`가 같은 타입에서 파생하므로 컴파일 타임에 검사된다 — 런타임에는 "타입을 우회한 값"만 상대하는 형태 검사(handler가 함수인지, state가 `getValue`를 갖는지, event가 Observable/source adapter인지)만 남는다. 타입을 우회해 만든 impl에 operation이 빠져 있어도 그 operation은 manifest에 없으므로 Renderer에 노출되지 않는다("빠진 구현을 던져서 잡는다"가 아니라 "빠진 구현은 노출될 방법이 없다"). 근거와 기존(런타임 재검증) 방식과의 비교는 [ADR 0012](adr/0012-lightweight-type-contract.md)와, 이력 문서인 [ADR 0008](adr/0008-contract-registration-match.md)에 있다.

도메인 스키마는 선택이며 operation 단위로 부분·점진 도입한다. `options.schemas: SchemasFor<B>`는 계약과 같은 모양의 부분 중첩 map으로, RPC는 `{ input?: Schema<I>; output?: Schema<O> }`, State·Event는 `Schema<T>` 하나다. 없는 항목은 도메인 스키마 없이 통과한다. `options.errors: ErrorsFor<B>`도 같은 모양이며 RPC operation에만 허용 도메인 에러 코드 목록(`readonly string[]`)을 둔다. 스키마·에러 map이 impl에 없는 경로를 참조하면(타입을 우회한 경우) 서버 생성 시 `TypeError`로 거부한다. `Schema<T>`는 `parse(value: unknown): T` 구조면 되고 zod 등 특정 라이브러리에 의존하지 않는다.

`options.authorize(context, operation)`는 등록된 operation에 대한 RPC·구독 요청마다 호출되는 앱의 인가 콜백이다(`boolean | Promise<boolean>`, 생략하면 전부 허용). `operation`은 `BridgeOperation { key, category, domain, operation }`이다 — `key`는 wire key(`rpc:admin/users/remove`), `category`는 `"rpc" | "state" | "event"`(`OperationCategory`), `domain`은 segment 배열(`["admin", "users"]`), `operation`은 이름(`remove`)이다. 등록 시 operation마다 한 번 만들어 객체와 `domain` 배열을 동결한다. 같은 operation이 같은 객체라는 동일성은 계약이 아니며 비교는 `key`로 한다. 두 타입은 `./main`에서 export하고 key 문법 모듈(`protocol/operation-key.ts`)은 공개하지 않는다. 진단 이벤트의 `key`는 wire key 문자열 그대로다. 근거는 [ADR 0018](adr/0018-authorize-structured-operation.md)에 있다.

요청 처리 순서는 스키마 유무와 무관하게 고정된다: `parseBridgeValue(input)`(구조·크기, 항상 적용) → 입력 스키마(있으면, 실패 시 `INVALID_ARGUMENT`) → handler → 출력 스키마(있으면) → `parseBridgeValue` + clone(항상 적용). "사용자 코드가 필요 없는 검사"(구조·크기 `parseBridgeValue`와 payload 한도, 세션 자원 한도, origin/sender 검사, envelope 파싱)는 도메인 스키마 유무와 무관하게 항상 유지된다 — 선택 도입의 대상은 사용자가 손으로 쓰는 검증 코드이지 라이브러리 내부 검사가 아니다.

Event buffer(용량과 overflow 정책)는 계약이 값을 가질 수 없으므로 Main에서 source를 만드는 시점의 옵션이다(`broadcastEvent(source, { buffer })`/`scopedEvent(factory, { buffer })`). 생략하면 기본값(`capacity: 100`, `overflow: "error"`)을 쓴다. `payloadLimits`도 같은 이유로 계약이 아니라 `createBridgeServer(impl, { payloadLimits })` 서버 옵션이다(ADR 0004 개정, 아래 "Payload 및 제한" 참고). buffer·source 모양(capacity·overflow 값, broadcast `source`가 Observable인지, scoped `factory`가 함수인지)은 helper 사용 여부와 무관하게 `createBridgeServer`의 등록 단계에서 검증한다 — 직접 작성한 source 객체 리터럴도 같은 규칙을 적용받는다([ADR 0012](adr/0012-lightweight-type-contract.md) 개정 note 참고).

## 요청 경로와 신뢰 경계

1. Renderer는 preload가 제공한 transport로 handshake를 시작하고 Main에서 공개 manifest를 받는다.
2. Electron 어댑터는 고정 namespace 채널에서 요청을 받아 sender를 `SenderIdentity`(`webContents` id, frame id, 현재 main frame 여부, origin)로 번역해 Main에 넘긴다. frame·origin 판정은 하지 않는다(아래 3번).
3. Main은 envelope를 파싱하고(version 포함) sender admission을 판정한 뒤 연결된 문서 세션과 도메인 계약을 확인하고 권한 함수를 적용한다.
4. RPC 입력과 출력, handshake 및 stream envelope는 프로토콜 파서와 payload 한도를 통과해야 한다. RPC handler와 stream source가 만든 값은 원시 값 검사 → 출력 스키마 변환 → 변환 결과 재검사 → 복제 → 복제본 검사 순서를 모두 통과해야 전송된다. 이 순서는 `src/main/output-boundary.ts`의 `parseOutput` 하나로 구현되어 RPC 출력과 stream 값(State/Event)이 공유하며, 두 번째 검사(복제 전)는 accessor·함수 값이 `structuredClone` 단계로 새는 것을 막고 복제는 검증 이후 handler·스키마가 쥔 참조로 값을 바꾸는 TOCTOU를 막는다.
5. 오류 응답은 안전한 프로토콜 오류 코드로 직렬화한다. 내부 예외나 원문 payload를 진단 정보에 기록하지 않는다.
6. 실패는 원인별로 분류된 코드로 응답한다: 입력 검증 실패는 `INVALID_ARGUMENT`다. handler가 선언되지 않은 예외를 던지거나 출력 검증이 실패하면(출력 스키마가 던진 예외 포함, 선언된 오류 코드를 가진 예외라도) `INTERNAL "Internal bridge error."`다. 선언된 도메인 에러라도 `message` 또는 `details`가 payload 한도(byte·깊이·항목 수·전체 byte)를 넘으면 같은 `INTERNAL`로 대체된다. 선언된 도메인 에러의 `details`도 검사 → 복제 → 복제본 검사를 거치며, `code`·`message`·`details`는 한 번만 읽어 검사한 값을 그대로 전송한다. 이 필드를 읽다 예외가 나도 `INTERNAL`이다. `authorize` 콜백이 throw하거나 reject해도 RPC·stream 모두 같은 `INTERNAL`이다([ADR 0011](adr/0011-authorize-exception-internal.md)). 출력 검증 실패 시 진단 정보에 `{ type: "validation-failed", key }`를 기록한다. 검증 실패 시점에 요청이 이미 취소된 상태(`context.signal.aborted`)면 `CANCELLED`가 이 분류보다 우선한다. 세션별 자원 한도(동시 RPC·구독 수) 초과는 `RESOURCE_EXHAUSTED`, Main이 스스로 설정한 RPC 실행 시간 상한 초과는 `DEADLINE_EXCEEDED`다 — 아래 "세션 자원 한도" 참고. 이 모든 거부와 완료 결과는 진단 이벤트로도 관측할 수 있다 — 아래 "운영 진단" 참고.

Electron 어댑터는 `allowedOrigins`를 받아 attach 시점에 현재 main frame·허용 origin 판정 함수(`isCurrentMainFrame`/`isAllowedOrigin`)를 만들어 target에 실어 보낸다 — 실제 판정은 Main의 sender admission(아래 "문서 세션과 정리")이 한다. 데모 앱의 authorization은 `main` 역할에 전체 공개 계약을 허용하고 `monitor` 역할에는 State/Event만 허용한다. 알 수 없는 역할은 허용되지 않는다. 앱은 별도로 navigation 및 window 생성 정책, sandbox, context isolation, preload 설정을 유지해야 한다.

## 배선 기본값

`bindElectronBridge({ ipcMain?, server, namespace?, allowedOrigins })`가 반환하는 `attach(contents, role?)`으로 Electron IPC 채널을 연결한다. `ipcMain`을 생략하면 호출 시점에 `import * as electron from "electron"`(네임스페이스 import)으로 얻은 `electron.ipcMain`을 읽고, 주입값이 있으면 항상 그 값이 우선한다. `namespace`를 생략하면 Main·preload 공통 기본값 `"default"`를 쓰며 채널은 `rx-bridge-electron:v1:default:*`가 된다. `role`을 생략하면 `"default"`다. role은 `authorize`의 `context.windowRole`로 전달되는 입력이므로, 역할로 인가를 나누는 앱은 창마다 명시한다.

preload의 `exposeBridgeInMainWorld(options?)`도 같은 방식으로 `contextBridge`·`ipcRenderer`를 호출 시점에 `electron.*`에서 해석하고(주입 우선), `namespace` 기본값은 Main과 같은 상수를 공유한다(정의 위치는 `src/protocol/electron-channels.ts`의 `DEFAULT_ELECTRON_BRIDGE_NAMESPACE`·`ELECTRON_BRIDGE_CHANNELS`이고, `/main`은 이를 재수출한다). `globalName` 기본값은 `"rxBridge"`다. Renderer의 `createRendererApi<B>(options?)`는 `options?.transport`를 생략하면 `globalThis.rxBridge`를 읽는다 — `globalName`을 기본값과 다르게 바꾼 소비자는 transport를 직접 만들어 넘겨야 하며, 그 경로에서만 `declare global`이 다시 필요하다. 두 기본값(`globalName`과 `createRendererApi`가 읽는 전역 이름)이 어긋나면 축약형 배선이 항상 실패하므로 두 지점은 같은 상수(`DEFAULT_BRIDGE_GLOBAL_NAME`, `src/renderer/transport.ts`)를 공유한다.

이 기본값들은 기존 함수의 인자를 선택화한 것이며 별도의 API를 추가하지 않는다 — 모든 인자를 명시하는 기존 호출은 동작이 바뀌지 않는다. `pagehide`에서 `api.dispose()`를 자동 호출하던 hello-world 예제는 이제 그 등록을 두지 않는다: navigation·창 파괴 시 Main이 이미 문서 세션을 retire하므로(위 "문서 세션과 정리" 참고) 불필요했다. `dispose()`는 브리지가 살아있는 동안 Renderer가 스스로 정리를 끝내려 할 때(SPA teardown) 쓰는 용도로 남는다. 근거와 기각한 대안은 [ADR 0013](adr/0013-wiring-defaults.md)에 있다.

## 문서 세션과 정리

Main은 연결된 `webContents`별로 현재 main-frame 문서와 client ID를 묶은 세션을 유지한다. sender admission(`DocumentSessions`의 private `#admit`)이 disposed·미attach → `sender-unauthorized`, subframe이거나 현재 main frame이 아님 → `frame-not-main`, 허용 목록 밖 origin → `origin-not-allowed` 순으로 판정하며, handshake·RPC·subscribe(`establish`)와 cancel·unsubscribe/acknowledge(`current`)가 채널과 무관하게 같은 판정을 공유한다. 이 세 사유로 subscribe가 거부되면 `subscribed` 확인 뒤 RPC와 같은 `error FORBIDDEN "Bridge sender is not authorized."`를 보낸다 — cancel·unsubscribe/acknowledge 거부는 여전히 응답하지 않는다(호출 자체가 fire-and-forget이다). main-frame navigation(main frame이 실제로 새 문서로 commit되는 시점 — navigation이 시작만 되고 같은 문서가 유지되는 이동은 retire하지 않는다, [ADR 0019](adr/0019-navigation-retire-on-commit.md)), renderer process 종료, `webContents` 파괴, detach 또는 서버 dispose가 세션을 retire하고 해당 세션의 RPC와 stream 구독을 중단한다. retire된 client ID는 같은 `webContents`의 새 문서 세션에서 재사용하지 않는다. retire 통지는 호출자(`RpcRequests`·`Subscriptions`)에게 raw `AbortSignal`이 아니라 세션 interface(`retireReason` getter, `onRetire(listener)` — 이미 retire된 세션이면 즉시 동기 호출)로 전달된다. 근거는 [ADR 0023](adr/0023-session-retire-interface.md)에 있다.

문서가 살아있는 채로 세션이 끝나면(detach 또는 서버 dispose) 그 세션의 활성 State/Event 구독과 `authorize` 대기 중이던 구독에 `error CANCELLED "Bridge session ended."`를 즉시 보낸다 — 쌓인 값(ACK 대기 포함)은 버린다. navigation(commit 시점)·renderer process 종료·`webContents` 파괴·새 `clientId`로 인한 retire(`replaced`)는 통지하지 않는다: 옛 문서 자신이 이미 없거나(navigation·process 종료·파괴) 재연결 흐름의 일부(새 clientId)이기 때문이다. 전송 실패는 삼킨다(best-effort) — 전송 실패가 세션·구독 정리를 막지 않는다. 통지 여부·코드는 `Subscriptions` 한 곳이 원인(admission 거부·시작 전 거부·대기 중 retire·활성 retire)과 retire 사유로 판정한다 — 시작 전 거부 응답을 보내기 직전(진단 sink의 동기 호출)이나 `subscribed` 전송 도중(동기 `send`) detach·dispose retire가 끼면 원래 거부 대신 `error CANCELLED`로 마감한다. `session-opened`·`subscription-opened` 진단을 기록하는 중에 동기로 detach·dispose가 일어나 등록 시점에 이미 retire된 pending 구독·consumer(`subscribed` 송신 전)도 같은 규칙을 따른다 — 사유가 detach·dispose면 `subscribed`(0) 뒤 `error CANCELLED`로 마감하고, 그 외 사유(navigation·`render-process-gone`·`destroyed`·`replaced`)는 무출력이다.

| retire 원인                           | 활성·`authorize` 대기 구독 통지 |
| ------------------------------------- | ------------------------------- |
| detach                                | `error CANCELLED`               |
| `server.dispose()` / bind `dispose()` | `error CANCELLED`               |
| navigation(commit)                    | 없음                            |
| `render-process-gone`                 | 없음                            |
| `destroyed`                           | 없음                            |
| 새 `clientId`(`replaced`)             | 없음                            |

근거는 [ADR 0020](adr/0020-stream-terminal-on-retire.md)에 있다.

이 소유 단위는 창이 아니라 렌더러 문서다. 한 창에서 reload/navigation이 발생하면 이전 문서에서 시작한 비동기 작업이 새 문서로 넘어가지 않아야 한다.

`server.dispose()`는 되돌릴 수 없다. 이후 `attach()`는 `BridgeProtocolError("FORBIDDEN", "Bridge server is disposed.")`를 동기로 throw하고, handshake·RPC·stream subscribe는 세션이 없을 때 쓰는 기존 거부 경로(handshake `INVALID_ARGUMENT "Invalid bridge request."` 응답, RPC `FORBIDDEN`, subscribe `subscribed` 뒤 `error FORBIDDEN`)로 응답한다. 반복 dispose는 no-op이다. dispose 시점에 살아있던 활성·`authorize` 대기 구독은 위 "문서 세션과 정리"의 통지 규칙대로 `error CANCELLED`를 받는다. retire된 client ID 기록은 서버 dispose 후에도 지우지 않는다 — 위 "재사용하지 않는다" 규칙이 종료 후에도 흔들리지 않아야 하기 때문이다. `destroyed` 수명 사건이 오면 해당 `webContentsId`의 retired 기록 전체를 지운다(그 `webContents`는 다시 살아나지 않는다). 살아 있는 `webContents`의 retired 기록은 최근 `maxRetiredClientsPerWebContents`개(기본 32)만 보관하고, 그보다 오래된 clientId는 기록에서 빠진다 — 그 시점 이후 재사용 방지는 `establish()`의 frame·origin 검사가 대신한다. 근거는 [ADR 0009](adr/0009-session-resource-limits.md)에 있다. `bindElectronBridge(...).dispose()`도 자신의 종료 플래그를 가지며, 반복 호출은 no-op이고 종료 후 `attach()`는 `BridgeProtocolError("FORBIDDEN", "Electron bridge is disposed.")`를 throw한다. 이 bind dispose는 자신이 등록한 cancel/control listener만 `removeListener`로 제거한다(`removeAllListeners`를 쓰지 않는다) — 같은 IPC 채널에 다른 코드가 등록한 listener를 건드리지 않기 위해서다. 근거는 [ADR 0006](adr/0006-shutdown-contract.md)에 있다.

## RPC와 스트림 계약

- **RPC**: 하나의 clone-safe 입력과 결과를 주고받는다. `AbortSignal`과 `timeoutMs`는 입력값과 분리된 호출 옵션이며 취소·timeout·응답 중 하나만 최종 결과가 된다.
- **State**: 현재값을 나타낸다. Renderer의 `RemoteState`는 `uninitialized`, `connecting`, `current`, `stale` snapshot을 제공한다. 마지막 로컬 구독자가 해제된 뒤 값이 있었으면 snapshot은 `stale`가 되며, 새 구독 generation에 예전 값을 현재값처럼 재생하지 않는다. `undefined`도 유효한 값이다. 같은 generation이 활성인 동안 늦게 합류한 로컬 구독자는 `subscribe()` 호출 안에서 현재값을 동기로 받는다. 아직 값을 받지 못한 `connecting` 상태에서는 첫 값을 기다린다.
- **Event**: 과거 값을 재생하지 않는 발생 스트림이다. 명시적인 buffer capacity와 `error`, `drop-oldest`, `drop-newest` 중 overflow 정책을 source 생성 옵션(`broadcastEvent`/`scopedEvent`의 `buffer`)에 둔다(생략 시 기본값). `error` 정책 overflow의 `STREAM_OVERFLOW`는 대기 값 전달 뒤에 도착한다. 구독 확인 이후 sequence와 acknowledgement로 전송을 제어한다.
- 같은 Renderer 문서의 여러 로컬 구독자는 하나의 local generation을 공유한다. Main의 non-scoped State/Event source는 operation key별로 활성 consumer 사이에서 공유한다. 문서별 Event source는 각 구독 context로 생성한다. 마지막 consumer가 나가면 더는 쓰지 않는 upstream을 정리한다.
- Event의 전달 방식은 등록 시점에 `broadcast`/`scoped` 둘 중 하나로 정규화된다: `broadcast`는 key당 upstream `Observable` 하나를 구독자들이 공유한다(plain `Observable`을 그대로 넘겨도 `broadcast`와 기본 buffer로 정규화된다). `scoped`는 구독마다 factory가 upstream을 새로 만들어 구독 사이에 값이 섞이지 않는다. 정규화는 registration 하나가 등록 시점에 수행하고, `Subscriptions` 내부 module `Upstreams`가 정규화된 두 갈래를 읽는다.
- `createBridgeServer<B>(impl, options)`는 계약과 구현의 일치(누락·초과 operation, handler·소스 타입)를 `B`/`BridgeImpl<B>` 타입 자체로 컴파일 타임에 강제한다. 런타임에는 impl 트리를 순회하며 "타입을 우회한 값"을 상대로 한 형태 검사만 수행한다: rpc handler가 함수인지, state 소스가 `Observable`이면서 `getValue`를 갖는지, event 소스가 `Observable`이거나 broadcast/scoped adapter 형태인지, 도메인·operation 이름이 segment 규칙(`src/protocol/operation-key.ts`가 정의하는 예약어·빈 segment·dotted segment 금지)을 지키는지. 위반하면 즉시 `TypeError`를 던진다. manifest는 이 impl 트리의 키에서 직접 만든다. 자세한 내용과 이전 방식(런타임 계약·등록 일치 검사)과의 비교는 [ADR 0012](adr/0012-lightweight-type-contract.md)에 있다.
- Renderer 공개 호출은 계층형 `api.<domain path>.rpc|state|event.<operation>`이다(`api.device.rpc.connect()`, `api.device.state.connection`). operation 이름은 `/` 없는 단일 segment이고, manifest 키(operation key, `category:domain/op`)의 마지막 segment가 operation이다. 도메인 경로의 모든 segment에서 `rpc`·`state`·`event`를, 도메인과 operation의 모든 segment에서 JS 예약어 `__proto__`·`prototype`·`constructor`·`then`을 예약한다. 규칙은 `src/protocol/operation-key.ts` 하나가 정의하고, Main은 생성 시 `TypeError`로, Renderer는 handshake 수신 시 `RemoteError("INTERNAL")`로 각각 독립적으로 거부한다(코드는 공유하고 신뢰는 공유하지 않는다). 도메인에 없는 종류는 노출하지 않는다. 근거는 [ADR 0007](adr/0007-hierarchical-renderer-api.md)에 있다. 루트 API는 `dispose`를 예약 도메인 이름으로 두고 `api.dispose()`를 `api[Symbol.dispose]`와 같은 함수로 노출한다([ADR 0005](adr/0005-renderer-api-shape.md)). `api.dispose()`는 되돌릴 수 없는 종료다: 진행 중인 RPC는 로컬에서 즉시 `CANCELLED`로 확정되고(Main에는 best-effort cancel을 보낸다), 활성 State/Event 구독은 `unsubscribe` 전송 후 `complete()`된다. 종료 후 호출한 RPC·subscribe는 전송 없이 같은 `CANCELLED` 오류로 끝난다. 종료 뒤에는 진행 중이던 batch의 acknowledge도 보내지 않는다. 종료 판정은 인스턴스당 하나이고 부작용 전에 확정된다. 진단 sink·`complete` 콜백 안에서 재진입해도 종료 뒤 규칙을 따른다. 의미와 근거는 [ADR 0006](adr/0006-shutdown-contract.md)에 있다.

## Payload 및 제한

v1 payload는 `undefined`, `null`, boolean, number, bigint, string, 배열, 일반 객체로 제한한다. 함수, symbol, 순환 참조, 사용자 정의 prototype, accessor/non-enumerable property, symbol key는 거부한다. 기본 한도는 깊이 32, 전체 항목 10,000개, 문자열 및 key UTF-8 길이 1,000,000 byte, 전체 크기 16 MiB(16,777,216 byte, `maxTotalBytes`)다. 서버 옵션 `payloadLimits`를 지정하면 해당 필드만 기본값을 덮어쓴다(병합).

전체 크기는 순회 중 근사 byte를 누적해 계산한다: 노드마다(원시값·배열·객체·`null`·`undefined` 모두) 8 byte, 문자열은 추가로 UTF-8 byte 길이, object key는 UTF-8 byte 길이(배열 `length`는 제외하지만 배열 원소의 index 문자열 키는 포함), bigint는 추가로 `ceil(abs(value).toString(16).length / 2)` byte. 실제 V8 structured clone 크기와는 다를 수 있는 근사값이다. 누적값이 `maxTotalBytes`를 넘으면 다른 payload 규칙과 같은 실패 분류를 따른다: RPC 입력은 `INVALID_ARGUMENT`, RPC 출력·stream 값·도메인 에러 `details`는 `INTERNAL`.

payload 한도는 서버(`createBridgeServer(impl, { payloadLimits })`)가 이 서버 옵션 기준으로만 적용한다(계약은 타입이라 값을 가질 수 없어 한도를 담지 못한다 — ADR 0012가 ADR 0004의 이 부분을 개정했다). envelope 자체(구조·순환 참조·함수·prototype 등 값 프로필)는 server(Main)·preload·Renderer가 각자 protocol의 `parse*`(`parseHandshakeRequest`/`parseWireRpcRequest`/`parseWireCancelRequest`/`parseWireStreamCommand`/`parseHandshakeResponse`/`parseRendererRpcRequest`/`parseRendererStreamCommand`/`parseRpcResponse`/`parseStreamMessage`)로 검사한다 — Electron 어댑터는 이 parse를 하지 않는다(`SenderIdentity` 번역과 채널 등록만 한다, 위 "요청 경로와 신뢰 경계" 2번). 이 envelope parse 단계의 구조 한도(깊이·항목 수·문자열 byte)는 `payloadLimits`가 아니라 protocol 내부 상수 `ENVELOPE_LIMITS`(`src/protocol/messages.ts`)이고 넉넉한 고정값이라 크기 한도로 기능하지 않는다(근거: [ADR 0004](adr/0004-validated-bounded-payloads.md), [ADR 0016](adr/0016-sender-admission.md) 결정 2).

## 세션 자원 한도

Main은 연결된 `webContents`의 현재 문서 세션 단위로 진행 중 RPC 수, 구독(대기+활성) 수, RPC 실행 시간, retired client ID 보관량을 제한한다. `createBridgeServer(impl, { resourceLimits })` 옵션으로 설정하며 모두 세션별이다 — 서버 전역(모든 세션 합계) 상한은 없다. 한 세션이 한도를 모두 소진해도 다른 세션의 RPC·구독은 영향받지 않는다.

| 옵션                              | 기본값  | 초과 시                                                                                     |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `maxConcurrentRpc`                | 64      | 다음 RPC는 `authorize`·handler 호출 없이 `RESOURCE_EXHAUSTED`                               |
| `maxSubscriptions`                | 256     | 다음 subscribe는 `subscribed` 다음 `RESOURCE_EXHAUSTED` `error`                             |
| `maxRpcDurationMs`                | 300,000 | handler `signal` abort 후 `DEADLINE_EXCEEDED`(`Infinity`면 없음, 유한값 최대 2,147,483,647) |
| `maxRetiredClientsPerWebContents` | 32      | 가장 오래된 retired clientId부터 기록에서 제거                                              |

RPC 슬롯은 취소나 deadline으로 응답을 먼저 보내도 handler Promise가 실제로 끝날 때 반환한다 — `AbortSignal`을 무시하는 handler는 자기 세션의 슬롯만 계속 점유한다. 구독 슬롯은 unsubscribe·거부·세션 retire 뒤 즉시 반환한다. 구독 시작 자체가 내부에서 실패해도(예: Event consumer 초기화 예외) 슬롯은 그대로 새지 않는다 — terminal error를 보낸 뒤 slot을 반환한다. source 쪽 종료(완료·오류·`error` 정책 overflow)는 source를 즉시 분리하지만, 이미 대기 중인 값을 ack 순서대로 모두 보낸 뒤 terminal(`complete` 또는 `error`, overflow는 `STREAM_OVERFLOW`)을 보내고 그 뒤에 슬롯을 반환한다. ack를 보내지 않는 소비자는 unsubscribe·세션 retire 전까지 슬롯 1개와 대기 값(Event는 최대 buffer capacity)을 계속 점유한다 — 그 세션의 한도 안에서만 영향이 있다.

stream `subscriptionId`의 재사용·늦은 도착은 ID별 저장소 대신 세션별 워터마크(마지막으로 수락한 sequence)로 판정한다. `subscriptionId`는 `<nonce>:<scope>:<seq base36>` 형식(`createOpaqueId` 산출 형식, 조립은 `src/protocol/opaque-id.ts`의 pure 함수 `formatOpaqueId`가 하고 `renderer/ids.ts`의 `createOpaqueId`가 nonce·sequence 상태를 쥔 채 호출한다)이어야 하며, 형식 오류는 같은 파일의 `parseOpaqueIdSequence`가 판정해 `INVALID_ARGUMENT`, 워터마크 이하는 메시지 없이 무시한다. RPC `requestId`는 워터마크 대상이 아니다.

stream 구독 요청은 ID 형식 → 세션별 워터마크 → 등록 조회 → 구독 슬롯 → `authorize` 순서로 판정한다(RPC와 같은 순서). 미등록 key는 `authorize` 호출 여부와 무관하게 항상 `NOT_FOUND`이고, `authorize`는 등록된 key만 받는다. 구독 슬롯 한도 초과(`subscription-limit`)는 등록 조회를 통과한 뒤 판정되므로 진단에 key를 포함한다. 이 수명주기(admission부터 terminal·slot 반환까지)는 Main의 `Subscriptions` 모듈 하나가 소유한다. 근거는 [ADR 0014](adr/0014-stream-lookup-before-authorize.md)에 있다. consumer 1건의 전달 창(수락 → ack 대기 → 다음 값 | terminal, 선점 종료 포함, sequence 번호)은 `Subscriptions` 내부 module `DeliveryWindow`가 단독 소유한다. State/Event upstream 연결(key별 공유·scoped 개별, 늦게 합류한 State 현재값)은 내부 module `Upstreams`가 소유한다. 시작 전 거부 frame의 sequence도 `DeliveryWindow`가 매긴다. `authorize` 호출과 예외·거부 분류, `authorize-denied` 진단은 RPC·stream이 공유하는 단계 하나가 맡고, 각 경로는 그 판정을 응답·프레임으로 번역만 한다([ADR 0011](adr/0011-authorize-exception-internal.md)).

RPC 요청은 envelope parse(version 포함) → 세션 해석(sender admission, `establish`) → 등록 조회 → RPC 슬롯 → `authorize` → pipeline(`parseBridgeValue` → 입력 스키마 → handler → 출력 경계) 순서로 판정한다. 미등록 key는 `authorize` 호출 여부와 무관하게 항상 `NOT_FOUND`다. 이 다섯 단계 경계(`authorize` 뒤, `parseBridgeValue` 실패, 입력 스키마 실패, handler 뒤, 출력 스키마 실패) 각각에서 요청이 이미 취소된 상태(signal aborted)면 `CANCELLED`가 그 단계의 원래 실패 분류보다 우선한다 — 이 규칙은 guard 함수 하나로 정의되고 다섯 지점에 적용된다(삭제하는 분기는 없다). 이 수명주기(등록 조회부터 handler 종료와 슬롯 반환까지)는 Main의 `RpcRequests` 모듈 하나가 소유한다. `authorize` 뒤에는 세션이 여전히 현재인지 별도로 재해석하지 않는다 — 요청 signal(세션 retire 시 abort)만 본다. 근거와 이 가설이 깨졌을 때의 위험은 [ADR 0015](adr/0015-rpc-request-lifecycle.md)에 있다. `authorize` 호출과 예외·거부 분류, `authorize-denied` 진단은 RPC·stream이 공유하는 단계 하나가 맡고, 각 경로는 그 판정을 응답·프레임으로 번역만 한다([ADR 0011](adr/0011-authorize-exception-internal.md)).

근거와 대안 비교는 [ADR 0009](adr/0009-session-resource-limits.md)에 있다.

## 운영 진단

Main은 `createBridgeServer(impl, { diagnostics })`로 넘긴 `DiagnosticsSink`에 닫힌 타입의 이벤트(`BridgeDiagnostic`)를 기록한다. `sink`가 없거나 `record`가 예외를 던져도 bridge 동작은 동일하다(호출을 삼키는 공통 함수 하나로 모든 기록 지점을 통과시킨다) — sink 실패가 RPC 응답이나 stream 전달에 영향을 주지 않는다. sink를 지정하지 않으면 기본 동작에서 어떤 콘솔 출력도 없다.

이벤트는 RPC 완료(`rpc-finished`, 성공·실패를 나타내는 `outcome` 포함)·취소(`rpc-cancelled`)·Main deadline 만료(`rpc-timed-out`)·출력 검증 실패(`validation-failed`)·Event 큐 깊이(`stream-queue`)와 드롭(`stream-dropped`)·거부(`rejected`, 11개 `RejectReason` 중 하나)·세션과 구독의 생성·해제(`session-opened`/`session-closed`, `subscription-opened`/`subscription-closed`)로 구성된다. 사유는 enum 코드, 식별자는 등록 조회를 통과한 와이어 key만 싣는다 — `Error` 객체, message, stack, 원문 payload, origin, clientId, webContentsId, requestId, subscriptionId는 어떤 이벤트에도 넣지 않는다. 모든 거부 판정은 Main(server)이 직접 sink에 기록한다 — Electron 어댑터는 진단을 기록하지 않는다(sink에 접근하지 않는다). `frame-not-main`·`origin-not-allowed`는 채널과 무관하게 sender admission이 판정하고, `malformed-envelope`은 server의 envelope parse가 4채널(handshake·rpc·cancel·control) 공통으로 판정한다. 한 요청에서 `rejected`는 최대 1회만 기록된다.

`server.getDiagnosticsSnapshot()`은 현재 활성 세션 수, in-flight RPC 수, 구독(대기+활성) 수, 대기 중 Event 수를 조회한다 — 이벤트 스트림과 달리 누적하지 않는 현재 스냅샷이며, 누적 카운터는 제공하지 않는다.

근거와 판정 지점 전체 목록, `RejectReason` 11개 각각의 판정 위치는 [ADR 0010](adr/0010-operational-diagnostics.md)에 있다.

Renderer(`src/renderer`)는 별도 진단 통로를 갖는다. `createRendererApi<B>(options)`의 `diagnostics` 옵션으로 넘긴 `RendererDiagnosticsSink`에 RPC 확정 원인(`rpc-settled`), 원격 구독의 시작·종료(`subscription-opened`/`subscription-closed`), 스트림 메시지 폐기(`message-dropped`), handshake 실패(`handshake-failed`), `transport.cancel`·`transport.control` 전송 실패 삼킴(`transport-failed`)을 동기로 기록한다. `rpc-settled`는 호출 하나당, `subscription-opened`/`closed`는 원격 구독(generation) 단위로 정확히 1회·1쌍 기록되며 로컬 구독자 수와 무관하다. 기록 금지 항목과 sink 예외 격리·기본 무출력 규칙은 Main의 `DiagnosticsSink`(위 문단)와 같다 — 예외는 `code`이며 `cause: "remote-error"`일 때만 싣는다. `RpcClient`·`StreamMultiplexer`는 Renderer main world에서 실행되므로 sink 콜백은 `contextBridge`를 건너지 않는다. Main `DiagnosticsSink`·`BridgeDiagnostic`과는 별개 타입이다 — 관측 지점과 식별자 규칙이 다르다(Renderer에는 `RejectReason`이 없고 로컬 확정 원인이 있다). 근거와 이벤트 타입 전체 목록은 [ADR 0022](adr/0022-renderer-diagnostics.md)에 있다.

## 데모와 증거 범위

`apps/demo`는 실제 장치 드라이버가 아니라 가상 장치와 relay를 통해 라이브러리의 계약, 역할 권한, State/Event, 다중 창 동작을 보여준다. 장치 연결 지원으로 해석하지 않는다.

검증 명령은 각 패키지의 `verify`와 CI workflow에 정의되어 있다. CI는 단위·타입·빌드 검사, 개발용 Electron acceptance, Linux packaged 실행 검사를 분리한다. package manifest의 Electron peer 범위(`>=29`)는 모든 Electron 버전에서 동일한 런타임 증명이 있다는 뜻이 아니다. 저장소 개발/CI 의존성은 `^44.4.5`이므로 다른 버전에서의 동작은 별도로 확인해야 한다. 실제 Electron 다중 창·반복 실행 검증의 환경과 결과는 [RD-008 검증 결과](verification/rd-008.md)에 있다.
