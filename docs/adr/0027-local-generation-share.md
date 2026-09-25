# Renderer `LocalGeneration`은 generation 공유를 rxjs `share`로 얻고, snapshot·열림 신호·종료 차단은 직접 소유한다

- 관련: [RD-050](../history/roadmap.md)

## 상황

`LocalGeneration`(`src/renderer/local-generation.ts`)은 operation key 하나의 로컬 구독자와 원격 구독 하나(generation)를 묶는다. 지금까지는 generation마다 `Subject`와 상태 구조체(`subscribers`, `closed`, `hasValue`, `latest`, `subscriptionId`)를 만들고 공유 규칙을 직접 구현했다.

- 로컬 구독자 수를 세고, 마지막 해제 때 `multiplexer.close`를 보낸다.
- 늦은 합류자에게 `latest`를 그 구독자에게만 동기로 재생한다.
- terminal 뒤에는 현재 generation을 비워, 다음 구독이 새 generation을 열게 한다.
- 늦은 통지를 막는 generation identity 검사(`this.#generation === generation`)가 4곳에 있다.

이 규칙은 rxjs `share({ connector: () => new ReplaySubject(1) })`에 reset 3종(`resetOnError`·`resetOnComplete`·`resetOnRefCountZero`)을 기본값 `true`로 둔 동작과 대응한다. 2026-09-26 prototype으로 확인했다.

- 기존 `test/renderer` 7 files/162 tests가 단언 변경 없이 통과했다.
- mutation 6종이 모두 RED였다: connector `Subject`, `resetOnRefCountZero: false`, `resetOnComplete: false`, 해제 시 비활성 전이 제거, 열림 신호 제거, 종료 뒤 차단 제거.
- 기존 test 밖 재진입 시나리오 10종에서 값·snapshot·control 전송 순서가 원본과 같았다.

## 결정

1. **공유는 `share`가 한다.** 원격 연결 하나는 `defer(() => new Observable(subscriber => this.#connect(subscriber)))`이고, 여기에 `share({ connector })`를 붙인다. connector는 State면 `ReplaySubject(1)`, Event면 `Subject`다. reset 3종은 기본값이다. 결과는 다음과 같다.
   - 로컬 구독자 공유와 마지막 해제 때 연결 해제는 refCount가 한다.
   - 늦은 합류자 재생은 `ReplaySubject`가 한다. `undefined`도 값으로 재생한다.
   - terminal 뒤 새 연결은 reset이 한다.

   `Generation` 구조체, 구독자 수, identity 검사, `hasValue`/`latest` 재생 분기는 없어진다.

2. **`share`가 대신하지 못하는 것은 같은 class가 직접 소유한다.**
   - snapshot 상태기계: `#connect` 진입 시 `connecting`, 값 도착 시 구독자 통지 전 `current`, terminal·마지막 해제 시 통지·`close` 전 비활성 전이.
   - "generation 열림" 신호([ADR 0024](0024-remote-state-snapshot-store.md) RD-044 개정): `multiplexer.open` 뒤 연결이 아직 끝나지 않았을 때만 쏜다.
   - 종료 뒤 subscribe 차단([ADR 0006](0006-shutdown-contract.md)): `share` 바깥 `subscribe` 한 곳에서 한다. 활성 generation에 합류하지 않는다.

3. **공개 export와 파일 경계는 그대로다.** `createRemoteState`·`createRemoteEvent`·`onGenerationOpened`, `RemoteStateClient`, `StreamMultiplexer`와의 계약(`open(key, handlers, registered)`·`close(subscriptionId)`)이 바뀌지 않는다.

4. **rxjs 구현 순서 의존을 test로 고정한다.** 재진입 동작은 rxjs 7.8 `share`의 다음 순서에 기댄다. 셋 다 rxjs 문서가 계약으로 명시하지 않는다.
   - 새 구독자를 connector에 먼저 붙인 뒤 source를 연결한다. 그래서 첫 구독자가 `multiplexer.open` 안의 동기 응답을 받는다.
   - complete·error 때 reset을 구독자 통지보다 먼저 한다. 그래서 `complete`·`error` 콜백 안의 재구독이 끝난 generation에 합류하지 않고 새 generation을 연다.
   - `Subject.next`는 순회 전에 구독자 목록을 복사한다. 그래서 `next` 콜백 안에서 합류한 State 구독자는 진행 중인 값을 replay로 1회만 받는다.

   `test/renderer/local-generation-reentrancy.test.ts`(10건)가 이 순서를 고정한다.

## 대안과 기각 사유

- **현재 구조 유지.** 재진입 순서의 근거가 코드와 주석에 그대로 보인다. 그러나 `share`가 이미 제공하는 refCount·reset·replay를 손으로 다시 구현한 상태이고, identity 검사·구독자 수 같은 수동 불변식을 계속 지켜야 한다. prototype과 회귀 test로 동등성을 확인했으므로 기각.
- **`shareReplay({ bufferSize: 1, refCount: true })`.** `resetOnComplete: false`라 원격 complete 뒤 구독자에게 옛 값과 complete를 재생하고 다시 연결하지 않는다. "stale 값은 재생하지 않고 새 generation을 연다"([ADR 0003](0003-state-and-event-delivery.md)) 계약과 맞지 않는다. 기각.
- **snapshot 전이를 `tap`·`finalize`·reset 콜백으로 흩어 두기.** 전이 지점이 연산자 체인 여러 곳으로 나뉜다. `finalize`는 구독자 통지 뒤에 실행돼 "snapshot 반영이 통지보다 먼저" 불변식을 지키지 못한다. 기각. 전이는 `#connect` 한 곳의 handler와 teardown에 둔다.

## 한계

- rxjs를 올릴 때 위 세 순서가 바뀌면 재진입 동작이 조용히 바뀐다. 회귀 test가 잡지만, test가 다루지 않는 재진입 조합은 원본과 같다는 보장이 없다.
- 코드 줄 수 감소는 주석을 빼면 약 30%(`LocalGeneration` class 164 → 113줄, prototype 기준)이고, 주석을 포함하면 파일 기준 311 → 279줄이다. 새 주석이 rxjs 순서 의존을 설명한다.

## 관련 ADR

- [ADR 0003](0003-state-and-event-delivery.md) — State·Event 전달 의미. stale 값 비재생 규칙이 connector·reset 선택의 근거다.
- [ADR 0006](0006-shutdown-contract.md) — 종료 뒤 subscribe 차단. 차단 위치는 `share` 바깥 한 곳이다.
- [ADR 0024](0024-remote-state-snapshot-store.md) — `snapshotStore`와 "generation 열림" 신호. 신호 발사 조건은 그대로다.
