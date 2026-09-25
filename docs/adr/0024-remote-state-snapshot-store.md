# Renderer는 `snapshotStore`로 `RemoteState`를 외부 store 계약으로 옮긴다

- 관련: ROADMAP.md#RD-043

## 상황

React 사용처는 `RemoteState<T>`를 `useSyncExternalStore`에 연결하기 위해 hook을 직접 작성해야 했다(`apps/demo/src/renderer/use-remote-state.ts`, 26줄, 사용 6곳: `App.tsx` 5·`RelayPanel.tsx` 1). 패키지·README는 "Observable + `.snapshot`"만 안내했다.

직접 작성할 때 틀리기 쉬운 지점은 셋이다.

1. `error`·`complete`도 변경 알림으로 받지 않으면 `stale` 전이가 렌더되지 않고 rxjs가 미처리 error를 보고한다.
2. subscribe 함수 참조가 렌더마다 바뀌면 `useSyncExternalStore`가 매 렌더 재구독해 generation이 새로 열린다.
3. 원격 종료(complete/error) 뒤에는 재구독하지 않는다는 계약을 직접 구현해야 한다.

`snapshot` 참조 안정성은 이미 보장돼 있다. `LocalGeneration#snapshot`(`packages/rx-bridge-electron/src/renderer/local-generation.ts:49`)은 값이 바뀔 때만 새 snapshot 객체를 만들고, 그 외에는 같은 참조를 돌려준다. adapter가 `getSnapshot`에서 캐시를 따로 둘 필요가 없다는 근거다.

_(개정: RD-049 — "값이 바뀔 때만 새 snapshot 객체"는 맞지 않다. `LocalGeneration`은 상태 전이와 `next` 도착마다 새 snapshot 객체를 만든다. 같은 값이 다시 와도 새 객체다. 그 사이의 읽기는 같은 참조를 돌려준다 — `getSnapshot` 캐시가 필요 없다는 결론은 그대로다.)_

## 결정

`/renderer`에 `snapshotStore<T>(state: RemoteState<T>): RemoteStateStore<T>`를 추가한다.

```ts
export interface RemoteStateStore<T> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => RemoteStateSnapshot<T>;
}
```

- store는 listener 집합과 `state` 구독 하나를 가진다. `subscribe(onChange)`는 listener를 추가하고, `state` 구독이 없거나 원격 종료로 끝났으면 새로 구독한다. `next`·`error`·`complete`마다 모든 listener의 `onChange()`를 인자 없이 호출한다. `error`는 알림으로만 쓰고 삼킨다 — 다시 던지지 않는다. 반환 함수는 그 listener만 제거하고, 마지막 listener가 나가면 `state` 구독을 해제한다.
- listener마다 `state`를 따로 구독하지 않는 이유: 원격 종료 뒤 한 listener(예: 새로 mount된 컴포넌트)가 새 generation을 열면 `getSnapshot`은 새 generation 값을 돌려주는데, 이미 종료된 구독을 가진 기존 listener는 알림을 받지 못한다. React에서는 같은 state를 읽는 컴포넌트끼리 다른 값을 렌더한다(tearing). 공유 구독이면 새 generation의 변경이 기존 listener에게도 전달된다.
- `getSnapshot`은 캐시하지 않는다. 호출 시점의 `state.snapshot`을 그대로 돌려준다.
- `WeakMap` 캐시로 같은 `state` 객체에는 같은 store(같은 `subscribe`·`getSnapshot` 함수 참조)를 돌려준다. React는 `useCallback` 없이 `useSyncExternalStore(store.subscribe, store.getSnapshot)`로 쓴다.
- store 함수는 `this`를 쓰지 않는 closure로 만들고, store 객체는 `Object.freeze`한다(ADR 0021의 API 트리 동결과 같은 취지 — React가 `subscribe`·`getSnapshot`을 분리해서 호출한다).
- 원격 complete/error 뒤에는 스스로 재구독하지 않는다. 새 listener가 들어올 때까지 snapshot은 `stale`(또는 `uninitialized`)에서 멈춘다.
- 입력은 공개 인터페이스 `RemoteState<T>`다. `RemoteState`·`RemoteStateSnapshot` 타입은 바뀌지 않는다.

### 범위 해석

ROADMAP "현재 범위 밖의 확장"은 "React 전용 패키지"를 제외한다. 이 제외는 유지한다. `snapshotStore`는 프레임워크 중립 adapter이고 React 의존성을 만들지 않는다 — README의 React 레시피는 사용자 코드로 예시일 뿐 패키지 의존성이 아니다. 따라서 이 adapter와 레시피는 "React 전용 패키지" 제외에 해당하지 않는다.

> **개정 (RD-044, `ROADMAP.md#RD-044`)**: store는 `LocalGeneration`의 모듈 내부 "generation 열림" 신호에 합류한다. 신호는 구현 내부 전용이고 공개 타입 `RemoteState`·`RemoteStateSnapshot`은 바뀌지 않는다 — `RemoteStateClient`가 아닌 입력(사용자 fake 등)은 여전히 이벤트 기반 그대로 동작한다. listener가 하나 이상 있는 동안에는 새로 열린 generation에 합류해 유지한다. 남이 연 generation도 포함하고, store 스스로 새 generation을 열지는 않는다. 알림 불변식은 `getSnapshot()`이 바뀌면 반드시 알린다는 것이다(여분 알림은 허용). 구독 중이던 listener도 자기 구독이 연 generation의 `connecting` 알림을 받는다. 신호는 `multiplexer.open` 뒤, 그 generation이 여전히 활성일 때만 발사한다. handler는 합류(`state.subscribe`)를 먼저 하고 그다음 listener에게 notify한다 — 순서를 뒤집으면 콜백이 동기로 generation을 닫았을 때 재합류가 자동 재구독이 된다. 종료를 store보다 먼저 받은 구독자(`repeat`·`retry` 등)가 그 안에서 동기로 새 generation을 열면 신호는 store가 아직 옛 generation에 붙어 있을 때 온다. 그래서 store는 자기 종료 처리에서 활성 generation이 있으면 합류한다(활성일 때만이라 새 generation을 열지 않는다). transport가 값을 동기로 보내 합류 중 알림 안에서 마지막 listener가 떠나면 합류 구독을 바로 놓는다. 신호 listener가 던지는 예외는 격리해 전파하지 않는다. Main 쪽 source 교체 지침은 패키지 README "State source 교체" 절을 참고한다.

## 대안과 기각 사유

- **`/react` subpath(React를 optional peerDep으로).** peerDep 관리, 별도 export 조건, 버전 호환 표가 늘어난다. `snapshotStore`는 React를 참조하지 않는 순수 함수라 subpath가 필요 없다.
- **별도 패키지(`@cp949/rx-bridge-electron-react`).** 발행·버전 동기화 비용이 생긴다. adapter 자체가 프레임워크 중립이라 분리할 이유가 없다.
- **`RemoteState`에 메서드 추가(`state.toStore()` 등).** `RemoteState`는 공개 인터페이스이므로 사용자가 만드는 fake·mock도 새 메서드를 구현해야 한다. 독립 함수로 두면 `RemoteState<T>` 모양만 만족하면 된다.
- **캐시 없는 함수(매 호출 새 store 생성).** React에서 안정된 참조를 얻으려면 호출부가 `useMemo`/`useCallback`을 직접 써야 해 hook 작성 부담이 그대로 남는다. `WeakMap` 캐시가 이 부담을 adapter 쪽으로 옮긴다.
- **자동 재구독.** 원격 종료는 ADR 0020이 정한 최종 상태이고, 자동 재구독은 그 계약과 충돌한다. 원격이 계속 종료하면 재구독이 반복된다.
- **snapshot에 error 추가.** `RemoteStateSnapshot`은 공개 계약이다. error를 실으려면 모든 소비자가 새 판별 분기를 갖게 되고, ROADMAP 결정("종료 원인은 노출하지 않는다")과도 어긋난다. 원인이 필요하면 `state`를 직접 구독한다.
- **snapshot 전이 신호를 발사 지점 3곳에 나눠 두는 방식(RD-044).** `next`·`error`·complete 각 경로마다 신호를 쏘면 발사 지점이 늘고, 기존 이벤트(`onChange`) 경로와 중복된다.
- **Main 쪽 평탄화만으로 해결(RD-044).** README 평탄화 지침만으로는 출력 검증 실패, 연결 실패, `authorize` 거부, 리소스 한도, 세션 종료로 끝나는 generation을 막지 못한다 — 이런 경로는 Renderer 쪽 합류가 있어야 listener가 알림을 받는다.
- **`RemoteState` 계약 자체를 generation을 넘어 잇는 방식(RD-044).** `complete`/`error`의 의미가 바뀌어 ADR 0003·ADR 0020에 영향을 준다.

## 한계

- 종료 원인을 store로 알 수 없다. `RemoteError`가 필요하면 `state.subscribe({ error })`로 직접 구독한다.
- 종료 뒤 자동 복구가 없다. 다시 구독하려면 컴포넌트를 remount한다 — 새 listener가 `state`를 다시 구독하고, 남아 있던 listener도 그 변경을 받는다. 남이 연 generation에는 합류한다(RD-044).

## 범위 밖

Event·RPC 편의 기능, TanStack Query 연동 예제 문서화. 후속 이슈로 등록한다(TanStack은 demo 의존성에 넣지 않고 문서 예제로만 둔다).
