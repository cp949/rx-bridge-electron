# `DocumentSession`의 retire 통지를 raw `AbortSignal` 대신 세션 interface로 노출한다

- 관련: ROADMAP.md#RD-037

## 상황

`DocumentSession`의 interface는 `{ target, clientId, signal }`이었다. 호출자(`RpcRequests` 4곳, `Subscriptions` 15곳)는 규약 4개를 각자 알아야 했다: `{ once: true }` 등록, 등록 직후 `signal.aborted` 재검사, 정상 종료 시 `removeEventListener`, 사유는 `signal.reason`(`any`)에서 `"detach"`·`"dispose"` 문자열로 비교. `RetireReason`은 `DocumentSessions.#retire`의 `abort(reason)` 호출부에서만 타입을 가졌고, 읽는 쪽(`endNotice`)은 `any`를 문자열로 비교했다 — 사유 이름이 바뀌어도 컴파일러가 잡지 못했다.

등록 3곳(RPC 요청, 구독 pending, 구독 consumer)은 등록 시점에 세션이 이미 retire된 경우를 서로 다르게 처리했다. 실측(그릴링 중 sub-agent 재현, 이 작업 DELTA-01에서 재확인)으로 다음이 드러났다.

| 분기               | 등록 시점 이미-retire 처리(수정 전)                    | ADR 0020 위반 여부     |
| ------------------ | ------------------------------------------------------ | ---------------------- |
| RPC `#begin`       | 즉시 `#cancelActive`(`CANCELLED "Request cancelled."`) | 없음 — ADR 0015와 일치 |
| 구독 pending 등록  | 무통지 return(정리만 하고 아무것도 보내지 않음)        | 위반                   |
| 구독 consumer 등록 | 무통지 `#close`                                        | 위반                   |

RPC 쪽은 이미 ADR 0015대로 동작했지만, 구독 pending·consumer 두 분기는 `session-opened`·`subscription-opened` 진단 sink가 동기로 detach·dispose를 일으키면 통지 없이 조용히 정리됐다 — ADR 0020 결정 5의 "활성 구독·`authorize` 대기 구독은 detach·dispose 시 통지한다" 표를 어겼다.

출처: 아키텍처 리뷰 `_works/arch-review/03.html` 후보 02와 그 grilling 결정(2026-09-25).

## 결정

### 1. `retireReason` getter 하나로 사유를 읽는다

```ts
interface DocumentSession {
  readonly target: AttachedTarget;
  readonly clientId: string;
  readonly retireReason: RetireReason | undefined;
  onRetire(listener: () => void): () => void;
}
```

살아 있는 세션은 `retireReason === undefined`다. `signal.aborted` 검사와 `signal.reason` 문자열 비교를 모두 이 getter 하나로 대체한다. `endNotice(cause, retireReason?: RetireReason)`의 사유 비교는 `RetireReason` literal 타입 검사를 받는다(`any` 비교 없음).

### 2. `onRetire(listener): () => void` — 이미 retire된 세션은 즉시 동기 호출한다

호출자가 등록 시점에 "이미 retire됐는가"를 스스로 재검사할 필요가 없도록, `onRetire`가 그 판정을 흡수한다.

- 살아 있는 세션에 등록하면 호출마다 독립 등록이다(같은 함수를 두 번 등록해도 두 번 호출된다 — `EventTarget.addEventListener`의 중복 무시를 피하려고 호출마다 새 wrapper로 감싼다).
- 이미 retire된 세션에 등록하면 `listener`를 반환 **전에** 동기 호출하고 no-op 해제 함수를 돌려준다.
- listener는 인자를 받지 않는다. 사유는 `retireReason`으로 읽는다 — listener 안에서도 이미 설정돼 있다.
- 반환된 해제 함수는 자기 등록만 지우고 멱등이다.
- 즉시 호출은 `EventTarget` dispatch를 거치지 않는다. 그 listener의 예외는 `onRetire` 호출자에게 그대로 전파된다 — 결정 4의 예외 격리는 등록 뒤 retire에만 적용된다. 지금 등록되는 listener 3종은 전송·진단 실패를 스스로 삼킨다.

이 즉시 호출 덕에 세 등록 지점(RPC entry, 구독 pending, 구독 consumer) 모두 "등록 전 retire"와 "등록 후 retire"를 같은 경로로 처리한다 — 호출자의 분기가 사라진다.

### 3. `retire(reason)`은 구현에만 있다. 사유 설정은 abort 전, 두 번째 호출은 no-op이다

```ts
class SessionImpl implements DocumentSession {
  readonly #controller = new AbortController();
  #reason: RetireReason | undefined;

  retire(reason: RetireReason): void {
    if (this.#reason !== undefined) return;
    this.#reason = reason;
    this.#controller.abort(reason);
  }
}
```

`retire`는 `DocumentSessions`만 부른다(호출자 2 module은 세션을 retire하지 않는다). 사유는 `abort` dispatch 전에 설정하므로 abort listener 안에서 `retireReason`이 이미 그 사유를 가리킨다.

### 4. 내부 `AbortController`를 유지한다 — 자체 listener `Set`으로 바꾸지 않는다

`onRetire`의 구현은 여전히 `AbortSignal`의 `addEventListener("abort", wrapper, { once: true })`를 쓴다. 두 성질을 그대로 보존하기 위해서다.

- **예외 전파**: Node `EventTarget`은 listener 예외를 dispatch 밖으로 보고하고 나머지 listener는 계속 호출한다. 자체 `Set`으로 직접 순회하며 호출하면 이 격리를 다시 구현해야 한다.
- **등록 순서 실행**: ADR 0015가 이미 수용한 "요청/구독 등록 순서 = 취소 실행 순서"를 그대로 유지한다.

`signal` 자체는 interface에서 제거했다(구현 class의 비공개 필드로만 남는다) — 호출자가 `AbortSignal`을 직접 참조할 이유가 없어졌기 때문이다.

### 5. 구현 class는 module 밖에 보이지 않는다

호출자에게 보이는 `DocumentSession` interface(읽기 전용 프로퍼티 + `onRetire` 구독)와 module 내부 구현 class(`SessionImpl`, export 안 함)를 분리한다. `SessionImpl`이 `AbortController`를 직접 쥐고, 이전에 있던 `#controllers` WeakMap(세션 → controller 매핑)을 삭제했다 — 세션 자신이 controller를 갖게 됐기 때문이다. `retire`는 class에만 있고 `DocumentSessions.#retire`만 호출한다. 호출자(`RpcRequests`·`Subscriptions`)의 import(`type DocumentSession`)는 바뀌지 않는다.

### 6. 등록 시점 이미-retire 구독 처리를 ADR 0020에 맞춘다(fix, DELTA-01)

interface 도입(DELTA-02·03)에 앞서, 기존 raw `signal` 구조 그대로 pending·consumer의 이미-retire 무통지를 고쳤다.

- **pending**: 이미-aborted 분기가 무통지 return하는 대신 `entry.onAbort()`(기존 `onAbort`가 필요한 처리 — pending 삭제·prune·`controller.abort()`·`#endUnstarted(retired)` — 를 이미 그대로 구현하고 있어 직접 호출로 충분했다)를 호출한다.
- **consumer**: `Consumer`에 mutable `opened: boolean` 필드를 추가하고 `subscribed` 송신 직전에 켠다. `onSessionAbort`가 이 값으로 갈린다 — open 전이면 `#close(consumer)` 뒤 `#endUnstarted(command, send, { kind: "retired" }, session)`로 거부 전용 창(`DeliveryWindow`)이 `subscribed`(0)·`error`(1) `CANCELLED "Bridge session ended."`를 매긴다. open 후면 기존처럼 `preempt` → `#send` → `#close`다.

consumer 등록 위치(open 송신 앞)는 그대로 뒀다 — open 송신 뒤로 옮기면 동기 `send` 중 `server.dispose()`가 일어나는 경로에서 `CANCELLED` 통지를 잃는다(아래 "기각한 안" 참고).

_(리뷰 수정, 2026-09-25: `subscription-opened` 진단 sink가 동기 unsubscribe로 consumer 창을 먼저 닫으면, `#close`가 부른 해제 handle은 아직 no-op 초기값이다. 그 뒤 `onRetire`가 살아 있는 세션에 등록한 listener가 남아, 나중 detach·dispose에서 해지된 구독으로 `subscribed`(0)·`CANCELLED`를 보냈다. `#start`는 등록 직후 창이 닫혀 있으면 방금 받은 handle을 해제한다. 변경 전 raw `signal` 구조에서는 같은 경로가 unsubscribe 직후 stray `subscribed`(0) 1건을 보냈다 — 이 수정 뒤에는 아무것도 보내지 않는다.)_

이 fix가 등록 시점 이미-retire를 "등록 직후 처리"로 통일해 뒀기 때문에, DELTA-03에서 `onRetire`의 즉시 동기 호출로 자연스럽게 흡수됐다 — `entry.onAbort()`/`consumer.onSessionAbort()` 직접 호출이 `session.onRetire(entry.onAbort)`/`session.onRetire(consumer.onSessionAbort)` 등록으로 바뀌었을 뿐이다.

## 기각한 안

- **자체 listener `Set`**: 예외 전파(EventTarget이 dispatch 밖으로 보고하고 나머지를 계속 호출하는 동작)를 다시 구현해야 한다. 이득 없이 위험만 늘어 기각했다.
- **listener가 사유를 인자로 받는 안**(`onRetire(listener: (reason: RetireReason) => void)`): 사유를 읽는 경로가 인자와 getter 둘로 갈라진다. getter 하나로 통일했다.
- **이미 retire면 `onRetire`가 `undefined`를 반환하는 안**: 호출자가 반환값을 보고 "이미 처리됐다"를 분기해야 한다. 즉시 동기 호출 + no-op handle로 호출자 분기를 완전히 없앴다.
- **consumer 등록을 open 송신 뒤로 옮기는 안**: 처리 순서(`sessions.dispose()`가 먼저 signal을 abort하고 `subscriptions.dispose()`가 그다음 consumer를 무통지로 닫는다, `create-bridge-server.ts:279-280`)상, listener가 open 송신 뒤에야 등록되면 동기 `send` 도중의 `server.dispose()`가 `CANCELLED`를 못 보낸다. 등록 위치는 그대로 두고 "open 여부" 플래그로 처리를 가르는 쪽을 택했다.

## 동작

**불변**: wire 메시지 순서·sequence·오류 코드·문구, 진단 이벤트 종류·순서, snapshot 값, slot 반환 시점, `create-bridge-server.ts`·`authorization.ts`(diff 없음). DELTA-02·03의 구조 이동 단계에서 기존 test 단언 변경은 0건이다.

**수용한 변화(동작 변경, DELTA-01)**: `session-opened`·`subscription-opened` 진단 창에서 동기로 detach·dispose가 일어나 등록 시점에 이미 retire된 pending 구독·consumer(`subscribed` 송신 전)도 이제 통지 대상이다. 사유가 detach·dispose면 `subscribed`(0) 뒤 `CANCELLED "Bridge session ended."`로 마감한다. navigation·`render-process-gone`·`destroyed`·`replaced`는 여전히 무출력이다(ADR 0020 결정 5 표 그대로).

## 범위 밖

slot 회계(RPC `running`, 구독 pending+consumers) — 반환 시점 의미가 세션 retire 노출 방식과 다르다. 리뷰 03 후보 04(payload limits 해석)·05(`LocalGeneration` kind 분기)와 리뷰 03 잔재 목록. `create-bridge-server.ts` 배선, `authorization.ts`, 공개 API(`DocumentSession`은 `src/main/index.ts`의 공개 export가 아니다), wire 모양, 오류 코드·문구, 진단 종류. Renderer 쪽 동작. _(개정: RD-041 — slot 회계는 내부 module `SessionSlots`가 소유하게 됐다. 이 ADR이 정한 `onRetire` 계약(등록·해제, 이미 retire된 세션에서의 즉시 호출) 자체는 바뀌지 않았다 — `SessionSlots`의 lease가 그 계약을 감싸 slot과 함께 노출한다.)_

## 이전(migration)

외부 사용 이력이 없다(버전 `0.0.0`). README "호환성 변경" 절에 항목을 추가하지 않는다. `DocumentSession`은 공개 export였던 적이 없어 라이브러리 사용자에게 이전 조치는 없다.

## 관련 ADR

- [ADR 0015](0015-rpc-request-lifecycle.md) — retire listener를 `session.signal`에 다는 서술, `session.signal`을 abort한다는 서술에 이 ADR로의 개정 표시를 남겼다. abort 메커니즘(내부 `AbortController`)은 구현으로 유지된다.
- [ADR 0020](0020-stream-terminal-on-retire.md) — 활성 구독·`authorize` 대기 구독의 retire 통지 판정. 이 ADR의 DELTA-01 fix가 결정 2의 통지 대상에 pending·consumer 이미-retire 두 경로를 추가했다(개정 표시를 남겼다).
- [ADR 0014](0014-stream-lookup-before-authorize.md) — `Subscriptions`가 구독 수명주기를 소유한다는 결정. `endNotice`·`#endUnstarted`가 이 ADR로 사유 인자 타입만 바뀐다.
