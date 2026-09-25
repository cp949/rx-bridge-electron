# `LocalGeneration`을 `share({ connector: () => new ReplaySubject(1) })` 기반으로 옮길지 검토

- Status: open — 검토 전. 동작 보존 refactor 후보이며 결함 수정이 아니다.
- 출처: 2026-09-25 그릴링(RD-044 논의 중 "Subject보다 `source$.pipe(share(), replay(1))`이 맞지 않나" 질문, `dev` @ `d83671a` 기준).

## 사실

- `src/renderer/local-generation.ts`의 `LocalGeneration`은 generation마다 `Subject` 하나를 만들고 로컬 구독자 수를 직접 센다. 늦은 합류자에게 현재값을 동기로 재생하고(`:85-98`), 마지막 해제 시 `multiplexer.close`를 보낸다(`:113-117`).
- rxjs 7에는 `replay` 연산자가 없다(`publishReplay`는 deprecated).
- `shareReplay({ bufferSize: 1, refCount: true })`는 `resetOnComplete: false`라 원격 complete 뒤 구독자에게 옛 값과 complete를 재생하고 재구독하지 않는다. "stale 값은 재생하지 않고 새 generation을 연다"는 계약(README `RemoteState` 절, `docs/architecture.md` State 항목)과 맞지 않는다.
- `share({ connector: () => new ReplaySubject(1) })`는 기본값이 `resetOnError`·`resetOnComplete`·`resetOnRefCountZero` 모두 `true`라 공유·refCount 해제·늦은 합류 재생·종료 뒤 새 연결 의미가 현재 동작과 대응한다.
- `share`가 대신하지 못하는 부분: snapshot 상태기계(connecting·current·stale·uninitialized, stale에서 값 유지, 구독자 전달 전 snapshot 반영), 종료 뒤 subscribe 차단(`:59-62`, `CANCELLED`), RD-044의 "generation 열림" 내부 신호. `defer`·`tap`·reset 콜백·`finalize`로 흩어서 구현해야 한다.
- 현재 구조는 의도한 통합이다: RD-022(Renderer stream client의 얕은 층을 `local-generation` 모듈 하나로), RD-031(generation terminal 경로 단일화).
- `share`로 바꿔도 generation 경계(원격 종료 시 구독자 전원 종료, 다음 구독이 새 연결)는 같다. RD-044가 푸는 store tearing과는 무관하다.

## 검토 질문

1. 연산자 체인으로 옮기면 snapshot·dispose·terminal 규칙이 흩어지는 비용보다 코드가 짧아지는 이득이 큰가.
2. snapshot 전이 순서(값 대입 → "열림" 신호/구독자 전달)와 재진입 안전성(RD-044 재진입 test)을 `share` reset 콜백 안에서 같은 수준으로 지킬 수 있는가.
3. Event(`kind: "event"`)도 같은 구조로 옮길 수 있는가(재생 없음 → `Subject` connector).

## 판정 기준

기존 `test/renderer/remote-state.test.ts`·`remote-event.test.ts`·`snapshot-store.test.ts`·`renderer-dispose.test.ts`·`renderer-diagnostics.test.ts`가 단언 변경 없이 통과해야 한다. 그렇지 않으면 채택하지 않는다.

## Comments
