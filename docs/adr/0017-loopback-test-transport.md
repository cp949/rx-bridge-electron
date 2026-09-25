# `@cp949/rx-bridge-electron/testing`의 `createLoopbackTransport` — test 전용 in-process `BridgeTransport` adapter

- 관련: [RD-020](../history/roadmap.md)

## 상황

`BridgeTransport`(`src/renderer/transport.ts:18-24`, `connect`·`invoke`·`cancel`·`control`·`onStreamMessage`)의 실제 adapter는 preload(`src/preload/expose-bridge.ts`) 하나뿐이었다. 이 seam을 검증하는 test는 세 갈래로 흩어져 있었다:

- `apps/demo/test/main-monitor.test.tsx`는 handshake manifest를 문자열 literal로 복제하고("`AppBridge`는 타입 계약이라 런타임 manifest를 만들지 못한다" 주석), RPC 응답 envelope를 손으로 조립했다.
- `apps/demo/test/use-remote-state.test.tsx`는 수기 `BridgeTransport`와 `subscribed`/`batch`/`complete` stream 메시지를 손으로 만들었다.
- `apps/demo/test/composition.test.ts`·`non-hardware-domain.test.ts`는 server(`dispatchRpc`/`controlStream`)를 직접 호출하며 opaque subscription ID(`"test:subscription:N"`)와 wire key(`` `rpc:relay/${operation}` ``, `"rpc:notes/append"`)를 문자열로 썼다.

RD-017·RD-019처럼 wire 형식(envelope·opaque ID·채널)이 바뀔 때마다 이 test들이 함께 깨졌다 — 라이브러리 내부 형식 변경이 라이브러리 소비자의 demo test까지 건드리는 셈이었다. 아키텍처 리뷰 01 카드 06이 이 문제를 "seam에 실제 adapter가 1개뿐"이라는 구조로 기록했다.

## 결정

### 위치: 새 subpath `@cp949/rx-bridge-electron/testing`, `./main`에 넣지 않는다

`createLoopbackTransport`는 `packages/rx-bridge-electron/src/testing/loopback-transport.ts`에 두고 `./testing`(`src/testing/index.ts`)으로만 공개한다. `./main`이나 `./renderer`에는 추가하지 않는다 — 소비자는 라이브러리 사용자의 test이지 운영 코드가 아니다. [ADR 0001](0001-fixed-preload-capability.md)이 "Renderer는 고정 preload transport만 노출한다"고 기록한 원칙에 예외를 만들지 않는다: loopback은 Renderer 프로덕션 진입점(`./renderer`)이 노출하는 능력이 아니라, 라이브러리를 쓰는 쪽이 test 코드에서 명시적으로 import하는 별도 subpath다.

### API 형태: `createLoopbackTransport(server, options?)`, server는 호출자가 만든다

```ts
export interface LoopbackTransportOptions {
  readonly sender?: Partial<SenderIdentity>;
  readonly clientId?: string;
  readonly role?: string;
}

export interface LoopbackTransport extends BridgeTransport {
  dispose(): void;
}

export function createLoopbackTransport(
  server: StreamBridgeServer,
  options?: LoopbackTransportOptions,
): LoopbackTransport;
```

(`packages/rx-bridge-electron/src/testing/loopback-transport.ts`)

`server: StreamBridgeServer`(`src/main/create-bridge-server.ts:105-116`)는 호출자가 `createBridgeServer(impl, options)`로 만들어 넘긴다 — `createLoopbackTransport`가 impl을 받아 내부에서 server를 만드는 형태(`createLoopbackBridge(impl)`류)는 채택하지 않았다. 생성 시 고정 `AttachedTarget`으로 `server.attach(target)`을 1회 호출해, admission 규칙(`DocumentSessions#admit`)의 구현 세부사항(`isCurrentMainFrame`/`isAllowedOrigin`/`onLifecycle` 형태)을 호출자가 몰라도 되게 한다.

### 옵션과 기본값

`options.sender: Partial<SenderIdentity>`는 기본값 `{ webContentsId: 1, frameId: 1, isMainFrame: true, origin: "loopback://test" }`와 병합된다. `options.clientId` 기본값 `"loopback-client"`, `options.role` 기본값 `"default"`(`server.attach`에 넘기는 target의 `role`). 다중 창을 흉내 내려면 `sender.webContentsId`(필요하면 `frameId`도)를 다르게 준 transport를 여러 개 만든다 — 한 `server`에 loopback transport를 여러 개 붙이는 것이 정상 사용법이다.

### 직렬화: 양방향 `structuredClone`, preload와 같은 protocol 함수

`connect`·`invoke`의 요청·응답, `control`이 전달하는 stream 메시지 모두 `structuredClone`을 거친다 — 실제 IPC 경계처럼 참조를 공유하지 않는다. envelope 조립은 `withEnvelope`, 검사는 `parseRendererRpcRequest`·`parseRendererStreamCommand`(요청, 호출 시점에 동기), `parseHandshakeResponse`·`parseRpcResponse`·`parseStreamMessage`(응답·stream, clone 뒤)를 쓴다(모두 `../protocol/index.js`에서 값으로 import) — preload adapter(`src/preload/expose-bridge.ts`)가 쓰는 것과 같은 protocol 함수를 같은 위치에 둔다. 그래서 server가 handshake를 거부하면(`RpcResponse` 반환) `connect()`는 preload처럼 `parseHandshakeResponse`에서 reject되고, 거부 응답을 `HandshakeResponse`로 넘기지 않는다(RD-020 리뷰에서 교정 — 최초 구현은 거부 응답을 그대로 resolve했다). 참조를 그대로 넘기는 안(clone 생략)은 채택하지 않았다 — clone-불가능한 값(함수, class 인스턴스)이 실제로는 도달하지 못한다는 사실 자체가 이 adapter가 검증해야 할 대상이기 때문이다.

_(개정: RD-049 — "양방향" clone은 범위가 좁다. `structuredClone`을 거치는 것은 `invoke` 요청, 모든 응답(handshake·RPC), stream 메시지다. handshake·cancel·control 요청은 `withEnvelope`로 새로 조립한 원시 필드 객체라 clone하지 않는다(`src/testing/loopback-transport.ts`). 어느 방향도 참조를 공유하지 않는다는 결과는 같다.)_

### 비동기 순서: `cancel`·`control`은 microtask로 미룬다

`cancel(requestId)`와 `control(command)` 모두 `queueMicrotask`로 server 호출을 미룬다. `control()`이 반환되기 전에 `onStreamMessage` listener가 호출되지 않는다 — server가 만든 stream 메시지 전달 자체도 별도 `queueMicrotask`를 한 번 더 거친다(listener 호출을 `control()` 호출 스택과 분리). preload가 실제 IPC 왕복으로 갖는 비동기성의 최소 형태를 유지하기 위해서다. 동기 호출(server 메서드를 즉시 호출하고 즉시 listener를 부르는 안)은 채택하지 않았다 — 동기라면 `control()` 반환 직후 listener가 이미 불렸다고 가정하는 소비자 코드의 타이밍 버그를 test가 잡지 못한다.

### server throw는 폴백 없이 그대로 드러낸다

`connect`·`invoke`는 server가 던지면 reject로, `control`의 microtask 안에서 server가 던지면 그 예외가 그대로 전파된다 — try/catch로 감싸 대체 응답을 만들지 않는다. preload adapter의 try/catch 폴백(`electron-adapter.ts`, handshake·rpc throw → `invalidRequest(value)`, cancel·control throw → 무시)은 운영 IPC 경계를 보호하는 장치이며, loopback은 그 경계를 흉내 내지 않는다 — server 자체의 버그를 test가 폴백 뒤로 숨기지 않아야 하기 때문이다. 이 폴백 공유(운영 adapter와 같은 try/catch를 loopback도 쓰는 안)는 채택하지 않았다.

### `dispose()`: detach와 listener 해제만, server는 건드리지 않는다

`dispose()`는 `server.attach`가 반환한 detach 함수를 호출하고 stream listener를 모두 지운다. 이후 `connect`·`invoke`는 reject, `cancel`·`control`은 조용히 무시한다(반복 호출 안전). `server` 자체는 dispose하지 않는다 — 한 `server`에 여러 loopback transport를 붙일 수 있으므로, transport 하나의 dispose가 다른 transport나 server 자체에 영향을 주면 안 된다. lifecycle 재현 API(`simulate(reason)`처럼 navigation·destroy 등 개별 수명 사건을 흉내 내는 기능)는 1차 범위에서 제외했다 — `dispose()`가 사실상 `destroyed`에 해당하는 것으로 충분하다고 봤다.

_(개정: RD-049 — "`dispose()`가 사실상 `destroyed`에 해당"은 맞지 않다. `dispose()`는 detach다(retire 사유 `detach`). detach는 [ADR 0020](0020-stream-terminal-on-retire.md)대로 활성·`authorize` 대기 구독에 `error CANCELLED`를 보내고(loopback은 listener를 먼저 지워 전달되지 않는다), retired clientId 기록을 남긴다. `destroyed`는 기록을 지운다. 그래서 같은 `webContentsId`·`clientId`로 다시 붙으면 거부된다([TRP-006](../traps/TRP-006-loopback-retired-clientid-reconnect.md)).)_

### 의존 경계: `./testing`은 main을 타입으로만 참조한다

`loopback-transport.ts`는 `StreamBridgeServer`·`AttachedTarget`·`SenderIdentity`를 `import type`으로만 가져온다(`../main/create-bridge-server.js`, `../main/types.js`). `electron`이나 `bindElectronBridge`·`ipcMain`을 런타임에 불러오지 않는다 — `dist/testing/index.js`와 그 import chunk 전체에서 `electron|bindElectronBridge|ipcMain` grep이 0건임을 빌드마다 확인한다(DELTA-01 결과).

## 거부한 대안

- **`./main`에 추가**: main 진입점은 Electron Main 프로세스에서 서버와 IPC 연결 설정을 만드는 책임만 진다. loopback을 여기 두면 "test 전용"이라는 소비자 구분이 export 목록에서 사라지고, main을 import하는 것만으로 test 유틸리티까지 번들에 끌려온다는 인상을 준다. 별도 subpath가 이 경계를 명시한다.
- **호출자가 직접 `server.attach`를 호출한 뒤 transport를 만드는 형태**: `createLoopbackTransport`가 `target`을 받는 형태였다면 호출자가 `AttachedTarget`의 4개 필드(`isCurrentMainFrame`/`isAllowedOrigin`/`onLifecycle`/`role`)를 직접 구현해야 했다 — admission 판정 로직(`DocumentSessions#admit`)의 존재를 test 작성자가 알아야 한다는 뜻이다. `server`만 받고 내부에서 고정 target을 만드는 현재 형태가 이 지식을 감춘다.
- **`createLoopbackBridge(impl)`(impl에서 server까지 내부에서 만드는 형태)**: server를 loopback이 소유하면 한 server에 여러 transport를 붙이는 용도(다중 창 흉내)를 표현할 수 없고, 호출자가 server 옵션(`authorize`·`schemas`·`diagnostics` 등)을 직접 조립하는 기존 test 패턴과도 어긋난다. `server`는 호출자가 만든다.
- **참조를 그대로 전달(clone 생략)**: 빠르지만 실제 IPC 경계(구조적 복제, 함수·클래스 인스턴스 불가)를 흉내 내지 못한다 — clone 관련 버그가 loopback을 쓰는 test에서 재현되지 않는다.
- **동기 호출(microtask 지연 없이 즉시 처리)**: `control()` 반환 직후 listener가 이미 호출됐다고 가정하는 타이밍 버그를 test가 놓친다.
- **preload adapter와 같은 폴백(try/catch로 throw를 안전한 응답으로 변환)을 loopback도 공유**: 운영 IPC 경계 보호 장치이지 test transport에 필요한 동작이 아니다 — server의 실제 버그를 폴백이 가려서는 안 된다.
- **preload adapter와의 parity test(같은 입력에 두 adapter가 같은 결과를 내는지 확인)**: 1차 범위 밖. 두 adapter는 전송 경계의 성격이 다르다(실제 Electron IPC vs in-process 호출) — 값 형태의 일치보다 각자 자기 계약(BridgeTransport 인터페이스)을 지키는지가 우선이었다.
- **`FakeTransport`(`test/renderer/fake-transport.ts`) 제거**: `FakeTransport`는 deferred 응답·호출 기록으로 경합·취소를 통제하는 도구다(`rpc-client`·`create-renderer-api`·`local-generation`·`remote-event`·`remote-state`·`renderer-dispose` test가 이 통제력에 의존한다) — loopback은 실제 server를 통과하므로 이 수준의 인위적 제어를 제공하지 못한다. `FakeTransport`는 유지하고, loopback은 demo test 4개(`use-remote-state`·`main-monitor`·`composition`·`non-hardware-domain`)만 대체한다.

## 결과

- [ADR 0001](0001-fixed-preload-capability.md)에 예외를 만들지 않는다 — Renderer 프로덕션 진입점(`./renderer`)은 여전히 고정 preload transport만 받고, `./testing`은 test 코드가 명시적으로 import하는 별도 subpath다. ADR 0001에 이 사실을 교차 참조하는 1줄을 추가했다.
- [ADR 0016](0016-sender-admission.md)의 범위 밖 절(:84, "후보 06: loopback adapter … 이 ADR의 새 시그니처는 그 adapter를 만들 수 있는 전제만 마련한다")과 대안 기각 사유(:72, "adapter마다(향후 loopback adapter 포함, 후보 06) 판정 순서가 어긋날 위험")가 전제한 것이 이 ADR로 충족됐다 — `createLoopbackTransport`는 판정 로직을 재구현하지 않고 `AttachedTarget`의 `isCurrentMainFrame`/`isAllowedOrigin`/`onLifecycle` port만 구현해 `DocumentSessions#admit` 하나에 판정을 맡긴다(ADR 0016 결정 1). 두 지점에 ADR 0017 참조를 추가했다.

## 범위 밖

- 운영(production) in-process client 용도(loopback은 test 전용이다).
- preload adapter와의 parity test.
- adapter try/catch 폴백을 loopback과 공유하는 것.
- lifecycle 재현 API(`simulate(reason)` 등 개별 수명 사건 흉내).
- 후보 07·08(이 ADR이 다루지 않는 별도 후보).

## 관련 ADR

- [ADR 0001](0001-fixed-preload-capability.md) — Renderer는 고정 preload transport만 노출한다는 원칙의 원 결정. 이 ADR이 예외를 만들지 않음을 교차 참조로 기록했다.
- [ADR 0016](0016-sender-admission.md) — sender admission을 `DocumentSessions#admit` 하나로 모은 결정(§ 결정 1)과, "후보 06: loopback adapter"를 범위 밖으로 남기며 이 adapter를 만들 수 있는 전제(판정 로직 재구현 없이 port만 구현하면 됨)를 마련한 원 결정.
