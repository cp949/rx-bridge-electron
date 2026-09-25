# `LocalGeneration`을 `share({ connector: () => new ReplaySubject(1) })` 기반으로 옮길지 검토

- Status: closed — RD-050 완료(ROADMAP.md#RD-050). prototype 판정 뒤 채택(2026-09-26). 동작 보존 refactor 후보이며 결함 수정이 아니다.
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

### 2026-09-26 prototype 판정 (`dev` @ `266a02d`)

사실:

- prototype: `LocalGeneration`을 `defer(() => new Observable(원격 연결))` + `share({ connector: state ? () => new ReplaySubject(1) : () => new Subject() })`(reset 3종 기본값 `true`)로 바꿨다. 공개 export(`createRemoteState`·`createRemoteEvent`·`onGenerationOpened`)와 파일 경계는 그대로다. snapshot 전이·"generation 열림" 신호·종료 뒤 subscribe 차단은 같은 class 안에 남는다.
- 판정 기준: `test/renderer` 7 files/162 tests가 단언 변경 없이 통과했다. 패키지 전체 46 files/881 tests, `check-types`도 통과했다.
- test 민감도(mutation, `test/renderer`): state connector를 `Subject`로 바꾸면 4 failed, `resetOnRefCountZero: false`면 18 failed, `resetOnComplete: false`면 13 failed, 해제 시 stale 전이를 빼면 4 failed, 열림 신호를 빼면 14 failed, 종료 뒤 차단을 빼면 7 failed.
- 기존 test 밖 재진입 probe 10종(next 안 재진입 구독, complete·error 안 재구독, 늦은 구독 `take(1)`, next 안 마지막 해제 뒤 재구독, 구독자 throw, event 재진입, next 안 dispose, `snapshotStore` 해제 순서, 해제 직후 재구독)을 원본과 prototype에 돌렸다. 값·snapshot·control 순서 로그가 같다.
- 코드량(주석·빈 줄 제외): 파일 238 → 180줄, `LocalGeneration` class 164 → 113줄. `Generation` 구조체, 구독자 수 계산, generation identity 검사 4곳, `hasValue`/`latest` 재생 분기가 사라진다.

가설:

- prototype의 재진입 동작은 rxjs 7.8 `share` 구현 순서에 기댄다. (1) 구독자를 connector에 먼저 붙이고 나서 source를 연결한다. (2) complete·error 때 reset을 구독자 통지보다 먼저 한다(complete 안 재구독이 새 generation을 연다). (3) `Subject.next`가 순회 전에 구독자 목록을 복사한다(전달 중 합류자는 replay만 받는다). 셋 다 rxjs 문서가 계약으로 명시하지 않는다. 위 probe가 이 순서들을 고정한다.

검토 질문 답:

1. 이득은 수동 상태(구독자 수, identity 검사) 제거와 코드 약 30% 감소다. 비용은 재진입 순서의 근거가 코드 주석에서 rxjs 내부 구현으로 옮겨 가는 것이다. probe를 회귀 test로 승격하면 rxjs 갱신 시 깨짐을 잡는다.
2. snapshot 전이 순서(값 대입 → 전달, stale 대입 → terminal 통지)와 RD-044 재진입 test는 같은 수준으로 지켜진다.
3. Event도 같은 구조(`Subject` connector)로 옮겨진다. prototype에 포함했다.

자료: `_works/20260926-07-local-generation-share/`(prototype, probe test, 두 로그).
