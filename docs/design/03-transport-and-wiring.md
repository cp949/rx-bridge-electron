# 03. Transport와 연결 설정

## 1. 목적과 범위

답하는 질문:

- Renderer는 Main에 무엇으로, 어떤 채널로 요청하는가. 무엇이 preload 경계를 넘지 않는가.
- 와이어 메시지(envelope)는 어떤 모양이고 누가 어디서 검사하는가.
- Electron adapter는 무엇을 하고 무엇을 하지 않는가.
- 연결 설정 인자를 생략했을 때 어떤 기본값을 쓰고, 왜 Main·preload·Renderer가 같은 상수를 공유해야 하는가.
- test 전용 loopback transport는 어디에 있고 preload와 무엇이 같은가.

다루지 않는 것:

- sender admission 판정 순서, 세션 수명과 retire: [04. 문서 세션](04-document-session.md)
- handshake manifest 해석과 Renderer API 트리: [02. Renderer API](02-renderer-api.md)
- RPC·stream 처리 순서: [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md)
- `ENVELOPE_LIMITS`·값 프로필·오류 코드 표: [08. Payload와 오류 모델](08-payload-and-errors.md)
- bind `dispose()`·`server.dispose()`의 종료 의미: [10. 종료](10-shutdown.md)
- 진단 이벤트: [11. 진단](11-diagnostics.md)

## 2. 모델

| 개념                              | 소유 모듈                                          | 역할                                                                          |
| --------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `BridgeTransport`                 | `src/renderer/transport.ts`                        | Renderer가 Main에 닿는 유일한 interface. 메서드 5개                           |
| `exposeBridgeInMainWorld`         | `src/preload/expose-bridge.ts`                     | 운영 adapter. 고정 채널로 IPC를 감싼 동결 transport를 `contextBridge`로 노출  |
| `ELECTRON_BRIDGE_CHANNELS`        | `src/protocol/electron-channels.ts`                | namespace에서 채널 이름 5개를 만든다. Main·preload 공유                       |
| `ProtocolEnvelope`·`withEnvelope` | `src/protocol/messages.ts`                         | 모든 메시지의 `protocolVersion`·`clientId`                                    |
| `parse*`                          | `src/protocol/messages.ts`                         | 채널·방향별 envelope 검사 함수                                                |
| `bindElectronBridge`              | `src/main/electron-adapter.ts`                     | Main 쪽 Electron adapter. IPC event를 `SenderIdentity`로 번역해 server에 전달 |
| `StreamBridgeServer`              | `src/main/create-bridge-server.ts`                 | Electron 비의존 protocol server. parse·admission·판정·진단 전부 소유          |
| `createLoopbackTransport`         | `src/testing/loopback-transport.ts`                | test 전용 두 번째 adapter. in-process로 server를 호출                         |
| `createOpaqueId`·`formatOpaqueId` | `src/renderer/ids.ts`, `src/protocol/opaque-id.ts` | `requestId`·`subscriptionId` 생성과 형식                                      |

### 신뢰 경계

Renderer main world가 받는 것은 동결된 `BridgeTransport` 객체 하나다. 다음은 preload 경계를 넘지 않는다.

- `ipcRenderer`, `IpcRendererEvent`, `webContents` 등 Electron 객체. stream listener는 IPC event를 버리고 파싱한 메시지만 넘긴다.
- 임의 채널 이름. 채널은 preload가 namespace에서 계산한 고정 5개뿐이다.
- `clientId` 선택권. `clientId`는 preload closure가 쥐고 `withEnvelope`로 붙인다. Renderer가 넘기는 `RendererRpcRequest`·`RendererStreamCommand`에 `clientId` 같은 필드가 있으면 strict key 검사가 `INVALID_ARGUMENT`로 거부한다. `withEnvelope`는 body의 같은 이름 필드보다 envelope 필드를 우선한다.
- sender 신원. `SenderIdentity`는 Main이 IPC event의 `senderFrame`에서 만든다. payload로 받지 않는다.
- handler, 자격증명, Node API, 함수·Observable·Subject. payload는 값 프로필([08](08-payload-and-errors.md))을 통과한 값만 오간다.

Renderer가 정하는 것은 `requestId`·`subscriptionId`·operation key·입력값·ack sequence뿐이다. Main은 이 값을 모두 다시 검사한다(parse → sender admission → 등록 조회 → `authorize` → payload 검사).

### `BridgeTransport` 5개 메서드

| 메서드                      | IPC 방식            | 의미                                                                                                                                 |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `connect()`                 | invoke(`handshake`) | handshake. Main이 문서 세션을 열고(`establish`) `HandshakeResponse`(manifest·`clientId`)를 돌려준다. 거부 응답이면 reject한다        |
| `invoke(request)`           | invoke(`rpc`)       | RPC 1건. 성공·오류 모두 resolve되는 `RpcResponse`다. reject는 전송·parse 실패뿐이다                                                  |
| `cancel(requestId)`         | send(`cancel`)      | RPC 취소 요청. fire-and-forget. 응답이 없다                                                                                          |
| `control(command)`          | send(`control`)     | `subscribe`·`unsubscribe`·`acknowledge`. fire-and-forget. 결과는 `onStreamMessage`로 온다. 잘못된 command는 호출 시점에 동기로 throw |
| `onStreamMessage(listener)` | on(`stream`)        | `subscribed`·`batch`·`error`·`complete` 수신 등록. 해제 함수를 돌려준다                                                              |

`createRendererApi`는 `connect()`를 한 번 호출한다. 이후 모든 RPC·stream이 같은 transport를 공유한다.

### 채널과 namespace

채널 이름은 `rx-bridge-electron:v1:${namespace}:<kind>`이고 `<kind>`는 `handshake`·`rpc`·`cancel`·`control`·`stream`이다. `ELECTRON_BRIDGE_CHANNELS(namespace)`가 유일한 생성 지점이다.

- `handshake`·`rpc`: `ipcMain.handle` / `ipcRenderer.invoke`. 요청-응답.
- `cancel`·`control`: `ipcMain.on` / `ipcRenderer.send`. 단방향.
- `stream`: Main → Renderer. Main은 `control` event의 `senderFrame.send`로 보내고 preload는 `ipcRenderer.on`으로 받는다.

namespace는 채널 자체를 분리한다. 서로 다른 server를 다른 namespace로 묶으면 한 창에서 여러 브리지가 섞이지 않는다. 한 브리지 안에서 창마다 인가를 나누는 `role`과는 다른 축이다.

채널 이름의 `v1`은 고정 문자열이다. envelope의 `protocolVersion`과 별개로 존재하며 `PROTOCOL_VERSION`에서 파생하지 않는다.

### Envelope와 protocol version

모든 메시지는 양방향 모두 `ProtocolEnvelope { protocolVersion: 1; clientId }`를 가진다. `PROTOCOL_VERSION = 1`은 `src/protocol/messages.ts` 하나가 정의한다.

- 요청: preload가 `withEnvelope(clientId, body)`로 붙인다.
- 응답·stream: server가 요청의 `clientId`로 `withEnvelope`를 붙인다.
- 각 `parse*`는 plain object와 정확한 key 집합(누락·초과 필드 거부)을 검사한다.
- `protocolVersion`이 숫자인데 1이 아니면 `BridgeProtocolError("VERSION_MISMATCH", "Unsupported protocol version.")`, 숫자가 아니면 `INVALID_ARGUMENT`다.

Renderer는 handshake 응답의 `protocolVersion`·`clientId`를 세션 값으로 저장하고, 이후 RPC 응답(`requestId` 포함)과 stream 메시지를 이 값과 대조한다. RPC 응답이 어긋나면 그 호출을 `INTERNAL "Malformed RPC response."`로 확정하고, stream 메시지가 어긋나면 `message-dropped`(`envelope-mismatch`)로 버린다.

`requestId`·`subscriptionId`는 Renderer의 `createOpaqueId(scope)`가 만든다. 형식은 `<nonce>:<scope>:<seq base36>`이다. nonce는 문서(JS realm)당 하나, sequence는 문서 안에서 1부터 단조 증가한다. 조립은 `formatOpaqueId`, 역파싱은 `parseOpaqueIdSequence`가 한다(둘 다 `src/protocol/opaque-id.ts`). server는 `subscriptionId` sequence만 워터마크로 쓴다([06](06-stream-delivery.md)).

### 누가 어디서 parse하는가

| 위치                               | 검사 함수                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| preload 송신                       | `parseRendererRpcRequest`(invoke), `parseRendererStreamCommand`(control). `cancel`은 검사 없이 조립 |
| server 수신                        | `parseHandshakeRequest`, `parseWireRpcRequest`, `parseWireCancelRequest`, `parseWireStreamCommand`  |
| preload 수신                       | `parseHandshakeResponse`, `parseRpcResponse`, `parseStreamMessage`                                  |
| Renderer(`createRendererApi` 내부) | `parseHandshakeResponse`, `parseRpcResponse`, `parseStreamMessage`를 다시 호출                      |
| Electron adapter                   | 없음                                                                                                |

Renderer가 preload 뒤에서 다시 parse하는 이유: `createRendererApi`는 `BridgeTransport` interface만 알고 구현을 신뢰하지 않는다. 앱이 직접 만든 transport도 같은 검사를 받는다.

### Electron adapter 책임

`bindElectronBridge`가 하는 일:

1. `senderIdentity(event)`: IPC event를 `SenderIdentity { webContentsId, frameId, isMainFrame, origin }`로 번역한다. `frameId`는 `senderFrame.routingId`, `isMainFrame`은 `event.sender.mainFrame === senderFrame`, `origin`은 frame URL의 origin이다. opaque origin(`"null"`)은 `${protocol}//${host}`로 바꾼다(`file:` URL은 `"file://"`). `senderFrame`이 `null`이면 `{ frameId: -1, isMainFrame: false, origin: "invalid://" }`다.
2. `targetFor(contents, role, allowedOrigins)`: attach 시점에 `AttachedTarget`을 조립한다. `isCurrentMainFrame`(webContents id·main frame 여부·`contents.mainFrame.routingId === sender.frameId`), `isAllowedOrigin`(`allowedOrigins.includes`), `onLifecycle`(navigation commit·`render-process-gone`·`destroyed` 구독)을 담는다. 판정은 이 함수를 호출하는 [04](04-document-session.md)의 `DocumentSessions`가 한다.
3. 채널 등록: handshake·rpc handler, cancel·control listener. 각 handler는 `server.<method>(senderIdentity(event), value)`를 그대로 호출한다.
4. `streamSender`: `control` event마다 `event.senderFrame?.send(channels.stream, message)`로 응답 경로를 만든다.
5. attach 관리: `webContents.id`당 attach 하나. 같은 id를 다시 attach하면 이전 detach를 먼저 호출한다. 교체된 뒤의 옛 detach 함수는 새 attach를 지우지 않는다.
6. 방어 fallback: handler가 throw하면 invoke 채널은 `invalidRequest(value)`(`INVALID_ARGUMENT "Invalid bridge request."`)를 반환하고 send 채널은 무시한다. 대상은 server가 아니라 adapter의 Electron 객체 접근(`senderFrame`·`frame.url`·`contents.mainFrame`)이다. 파괴된 frame·webContents 접근은 throw할 수 있다. server는 잘못된 값을 응답이나 침묵으로 처리하고 throw하지 않는다. `controlStream`의 Promise는 reject하지 않으므로 adapter가 `void`로 버린다.

하지 않는 일:

- envelope parse와 version 판정.
- frame·origin·clientId 판정(sender admission).
- 등록 조회, `authorize`, payload 검사.
- 진단 기록. adapter는 `DiagnosticsSink`에 접근하지 않는다.

이 분리로 판정 순서와 거부 사유는 server 한 곳에 고정된다. adapter를 추가해도(loopback 포함) 판정 로직을 재구현하지 않고 `AttachedTarget` port만 구현하면 된다.

## 3. 불변식

1. Renderer main world에 노출되는 브리지 능력은 `BridgeTransport` 5개 메서드뿐이다. 노출 객체는 `Object.freeze`로 동결한다.
2. `clientId`는 preload가 소유한다. Renderer 입력은 envelope 필드를 덮어쓸 수 없다.
3. 모든 와이어 메시지는 `protocolVersion: 1`과 `clientId`를 가진다.
4. envelope parse·admission·판정·진단은 server(`StreamBridgeServer`)만 한다. adapter는 번역과 채널 연결만 한다.
5. Main과 preload의 기본 namespace는 같은 상수 `DEFAULT_ELECTRON_BRIDGE_NAMESPACE`다. preload 기본 `globalName`과 `createRendererApi`가 읽는 전역 이름은 같은 상수 `DEFAULT_BRIDGE_GLOBAL_NAME`이다.
6. `allowedOrigins`에는 기본값이 없다.
7. `src/{preload,protocol,renderer,testing}`은 `src/main/*`을 값으로 import하지 않는다(`import type`만 허용, eslint `@typescript-eslint/no-restricted-imports`가 강제). `src/protocol/electron-channels.ts`는 런타임 import가 없는 leaf다.
8. loopback transport는 `./testing` subpath에만 있고 `electron`을 런타임에 불러오지 않는다.

## 4. 흐름

### handshake

1. Renderer `createRendererApi`가 `transport.connect()`를 호출한다.
2. preload가 `ipcRenderer.invoke(channels.handshake, withEnvelope(clientId, {}))`를 보낸다.
3. adapter가 `server.handshake(senderIdentity(event), value)`를 호출한다.
4. server가 `parseHandshakeRequest`로 검사한다. 실패하면 `version-mismatch` 또는 `malformed-envelope`을 기록하고 `INVALID_ARGUMENT "Invalid bridge request."`를 반환한다. handshake는 version 불일치도 이 모양으로 응답한다.
5. server가 `DocumentSessions.establish(sender, clientId)`로 세션을 연다([04](04-document-session.md)). 거부되면 사유를 기록하고 4와 같은 응답을 반환한다.
6. 통과하면 `withEnvelope(clientId, { manifest })`를 반환한다.
7. preload가 `parseHandshakeResponse`로 검사한다. 거부 응답(`RpcResponse` error 모양)은 key 집합이 달라 여기서 throw되고 `connect()`는 reject된다.
8. Renderer가 응답을 다시 parse해 세션 envelope를 저장하고 manifest를 해석한다([02](02-renderer-api.md)). `connect()` reject는 `INTERNAL "Bridge handshake failed."`로 끝난다.

세션은 handshake에서만 열리지 않는다. RPC·subscribe도 `establish`를 거치므로 새 `clientId`의 첫 RPC가 세션을 열 수 있다.

### RPC·stream 요청

- RPC: preload가 요청을 parse하고 envelope를 붙여 invoke → server `dispatchRpc` → 응답 → preload `parseRpcResponse` → Renderer `parseRpcResponse`와 envelope·`requestId` 대조.
- stream: preload가 command를 parse하고 envelope를 붙여 send → server `controlStream` → 이 event의 `senderFrame`으로 stream 메시지 송신 → preload `parseStreamMessage` → Renderer 재검사.
- preload의 stream listener wrapper는 parse 실패와 listener 예외를 모두 삼킨다.

### 연결 설정 기본값

| 인자                          | 함수                                            | 생략 시                                                                    |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `ipcMain`                     | `bindElectronBridge`                            | 호출 시점에 `electron.ipcMain`. 없으면 `TypeError`                         |
| `namespace`                   | `bindElectronBridge`, `exposeBridgeInMainWorld` | `"default"`(`DEFAULT_ELECTRON_BRIDGE_NAMESPACE`)                           |
| `allowedOrigins`              | `bindElectronBridge`                            | 생략 불가                                                                  |
| `role`                        | `attach(contents, role?)`                       | `"default"`. `authorize`의 `context.windowRole` 입력일 뿐 검사를 끄지 않음 |
| `contextBridge`·`ipcRenderer` | `exposeBridgeInMainWorld`                       | 호출 시점에 `electron.*`. 없으면 `TypeError`                               |
| `globalName`                  | `exposeBridgeInMainWorld`                       | `"rxBridge"`(`DEFAULT_BRIDGE_GLOBAL_NAME`)                                 |
| `clientId`                    | `exposeBridgeInMainWorld`                       | 호출마다 `client-${crypto.randomUUID()}`                                   |
| `transport`                   | `createRendererApi`                             | `globalThis.rxBridge`. 5개 메서드가 함수가 아니면 `TypeError`              |

주입값은 항상 기본값보다 우선한다. 기본값 해석은 호출 시점이다.

기본값이 어긋나면 실패하는 이유:

- namespace: Main과 preload가 각자 기본값을 두면 한쪽만 생략했을 때 채널 이름이 달라진다. preload의 invoke는 handler 없는 채널로 가고, send는 아무도 받지 않는다. 조용한 실패를 막으려고 두 지점이 `src/protocol/electron-channels.ts`의 같은 상수를 쓴다. `/main`은 이 상수를 재수출만 한다.
- globalName: preload가 노출한 이름과 `createRendererApi`가 읽는 이름이 다르면 축약형 Renderer 연결 설정이 항상 `TypeError`로 실패한다. 두 지점이 `src/renderer/transport.ts`의 같은 상수를 쓴다. 이 파일은 `electron`에 의존하지 않아 preload·Renderer 번들이 모두 import한다. `globalName`을 바꾼 앱은 전역을 직접 읽어 `transport`로 넘긴다.

`electron`은 `import * as electron from "electron"`으로 참조한다. Electron 밖(Node test)에서 `electron` 패키지는 실행 파일 경로 문자열만 export하므로 named import는 ESM 링크 단계에서 `SyntaxError`를 낸다. namespace import는 링크되고 없는 프로퍼티는 `undefined`가 되어, 기본값 경로를 탔을 때만 명확한 `TypeError`로 실패한다.

`createBridgeServer`와 `bindElectronBridge`는 분리돼 있다. server는 Electron 없이 단위 test할 수 있고, adapter는 그 server를 IPC에 연결만 한다.

### loopback test transport

`createLoopbackTransport(server, options?)`는 `@cp949/rx-bridge-electron/testing`만 공개한다.

1. 생성 시 고정 `AttachedTarget`으로 `server.attach(target)`을 1회 호출한다. `isCurrentMainFrame`은 `webContentsId`·`frameId`·`isMainFrame`을, `isAllowedOrigin`은 `sender.origin`과의 일치를 본다. `onLifecycle`은 아무 사건도 내지 않는다.
2. 기본값: `sender` `{ webContentsId: 1, frameId: 1, isMainFrame: true, origin: "loopback://test" }`(부분 병합), `clientId` `"loopback-client"`, `role` `"default"`. 다중 창은 `webContentsId`가 다른 transport를 같은 server에 여러 개 붙여 흉내 낸다.
3. envelope 조립과 검사는 preload와 같은 protocol 함수(`withEnvelope`, `parseRendererRpcRequest`·`parseRendererStreamCommand`·`parseHandshakeResponse`·`parseRpcResponse`·`parseStreamMessage`)를 같은 지점에서 쓴다. 같은 입력이 preload와 같은 지점에서 실패한다. server의 handshake 거부는 `connect()` reject가 된다.
4. `invoke` 요청, 모든 응답, stream 메시지는 `structuredClone`을 거친다. handshake·cancel·control 요청은 새로 조립한 원시 필드 객체다. 어느 방향도 참조를 공유하지 않는다. 함수·class 인스턴스가 경계를 넘지 못하는 사실을 test가 관측한다.
5. `connect`·`invoke`는 호출 즉시 server를 부른다. `cancel`·`control`은 `queueMicrotask`로 server 호출을 미루고, stream 메시지 전달도 microtask를 한 번 더 거친다. `control()`이 반환되기 전에 listener는 호출되지 않는다.
6. server가 던지면 폴백 없이 그대로 드러난다(`connect`·`invoke`는 reject).
7. `dispose()`는 detach와 listener 해제만 한다. server는 dispose하지 않는다. 이후 `connect`·`invoke`는 reject, `cancel`·`control`은 무시한다. listener를 detach보다 먼저 해제하므로 detach의 `CANCELLED` 통지와 이미 예약된 stream 메시지는 구독자에게 가지 않는다. 그 transport의 `RemoteState`는 마지막 상태(`current` 등)로 남는다.

loopback은 [ADR 0001](../adr/0001-fixed-preload-capability.md)의 예외가 아니다. `./renderer`는 여전히 `BridgeTransport`만 받고, Renderer에 노출되는 운영 transport는 preload 하나다. loopback은 test 코드가 명시적으로 import하는 별도 subpath이고 `./main`을 타입으로만 참조한다.

## 5. 설계 이유와 기각한 대안

- Renderer에 고정 transport만 노출한다: Renderer의 IPC 권한을 계약 범위로 제한하고, 권한과 payload는 Main이 다시 확인한다([ADR 0001](../adr/0001-fixed-preload-capability.md)).
- parse를 server가 소유한다: 같은 실패가 채널마다 다른 사유가 되던 문제를 없앤다. version 불일치가 실제로 `version-mismatch`로 기록된다([ADR 0016](../adr/0016-sender-admission.md)).

기각한 대안:

- raw `ipcRenderer`·임의 채널 노출: Renderer IPC 권한이 계약 범위를 벗어난다.
- parse는 adapter에 두고 `VERSION_MISMATCH`만 server로 넘김: 구조 오류와 version 오류를 두 곳에서 판정해 사유 불일치가 남는다.
- `bindElectronBridge`가 sink를 직접 받음: sink 설정 지점이 둘이 되고 같은 요청의 중복 `rejected` 기록을 조율해야 한다.
- `AttachedTarget`에 `admit(sender)` port 추가: adapter마다 판정 순서가 어긋날 수 있다. test target도 순서를 재구현해야 한다.
- `electron` named import: Node 실행 환경에서 ESM 링크 단계 `SyntaxError`.
- `*Simple`/`*WithDefaults` 병행 API나 overload: 진입점이 늘어 문서·타입 추론·유지 비용이 커진다. 기존 함수의 인자 선택화로 충분하다([ADR 0013](../adr/0013-wiring-defaults.md)).
- `allowedOrigins` 기본값: 실수로 모든 origin을 허용하기 쉽다. origin 검사는 보안 경계 자체다.
- `createBridgeServer`·`bindElectronBridge` 통합: server 단위 test가 Electron에 묶인다.
- 채널 상수를 공개 `./protocol` export에 포함: protocol 공개 표면은 transport 중립이어야 한다. 채널은 Electron adapter 전용이다.
- loopback을 `./main`에 추가: test 전용이라는 구분이 export 목록에서 사라진다.
- `createLoopbackBridge(impl)`: server를 loopback이 소유하면 한 server에 여러 transport를 붙일 수 없다.
- 호출자가 target을 만들어 넘김: test 작성자가 admission port 4개를 알아야 한다.
- clone 생략: clone 불가 값 관련 버그가 재현되지 않는다.
- 동기 호출: `control()` 반환 직후 listener가 이미 불렸다고 가정하는 타이밍 버그를 test가 놓친다.
- 운영 adapter의 try/catch 폴백 공유: server 버그를 폴백이 가린다.

## 6. 한계

- replay 없는 broadcast Event를 구독 직후 곧바로 emit하면 server 쪽 upstream 구독이 아직 확정되지 않아 값을 놓친다. preload도 IPC가 비동기라 같다. loopback에서는 microtask 순서 때문에 매번 재현된다([TRP-005](../traps/TRP-005-loopback-event-subscribe-race.md)).
- loopback `dispose()` 뒤 같은 `webContentsId`·`clientId`로 새 loopback을 만들면 retired `clientId` 규칙으로 거부된다([TRP-006](../traps/TRP-006-loopback-retired-clientid-reconnect.md)). 새 문서를 흉내 내려면 `clientId`를 바꾼다.
- loopback은 수명 사건(navigation·`render-process-gone`·`destroyed`)을 재현하지 않는다. `dispose()`는 detach(retire 사유 `detach`)다.
- preload는 stream listener 예외를 삼키지만 loopback은 listener를 microtask 안에서 try 없이 호출한다.
- preload adapter와 loopback의 parity test는 없다.
- 창 URL은 navigation commit 시점에 보이지만 Renderer script 실행과 handshake는 그 뒤에 끝난다. e2e에서 창 URL 확인 직후 Renderer 전역을 읽으면 경쟁한다([TRP-003](../traps/TRP-003-electron-renderer-global-race.md)).
- 실제 Electron 검증은 Electron 44.4.5, Linux에서만 했다([실제 Electron 검증 결과](../verification/rd-008.md)).

## 7. 관련 문서

- ADR: [0001](../adr/0001-fixed-preload-capability.md), [0013](../adr/0013-wiring-defaults.md), [0016](../adr/0016-sender-admission.md), [0017](../adr/0017-loopback-test-transport.md)
- 함정: [TRP-002](../traps/TRP-002-preload-bundle-server-import.md), [TRP-003](../traps/TRP-003-electron-renderer-global-race.md), [TRP-005](../traps/TRP-005-loopback-event-subscribe-race.md), [TRP-006](../traps/TRP-006-loopback-retired-clientid-reconnect.md)
- 설계: [02. Renderer API](02-renderer-api.md), [04. 문서 세션](04-document-session.md), [08. Payload와 오류 모델](08-payload-and-errors.md), [10. 종료](10-shutdown.md), [11. 진단](11-diagnostics.md)
