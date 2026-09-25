# Renderer는 `snapshotStore`로 `RemoteState`를 외부 store 계약으로 옮긴다

- 관련: ROADMAP.md#RD-043

## 상황

React 사용처는 `RemoteState<T>`를 `useSyncExternalStore`에 연결하기 위해 hook을 직접 작성해야 했다(`apps/demo/src/renderer/use-remote-state.ts`, 26줄, 사용 6곳: `App.tsx` 5·`RelayPanel.tsx` 1). 패키지·README는 "Observable + `.snapshot`"만 안내했다.

직접 작성할 때 틀리기 쉬운 지점은 셋이다.

1. `error`·`complete`도 변경 알림으로 받지 않으면 `stale` 전이가 렌더되지 않고 rxjs가 미처리 error를 보고한다.
2. subscribe 함수 참조가 렌더마다 바뀌면 `useSyncExternalStore`가 매 렌더 재구독해 generation이 새로 열린다.
3. 원격 종료(complete/error) 뒤에는 재구독하지 않는다는 계약을 직접 구현해야 한다.

`snapshot` 참조 안정성은 이미 보장돼 있다. `LocalGeneration#snapshot`(`packages/rx-bridge-electron/src/renderer/local-generation.ts:49`)은 값이 바뀔 때만 새 snapshot 객체를 만들고, 그 외에는 같은 참조를 돌려준다. adapter가 `getSnapshot`에서 캐시를 따로 둘 필요가 없다는 근거다.

## 결정

`/renderer`에 `snapshotStore<T>(state: RemoteState<T>): RemoteStateStore<T>`를 추가한다.

```ts
export interface RemoteStateStore<T> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => RemoteStateSnapshot<T>;
}
```

- `subscribe`는 `state`를 구독해 `next`·`error`·`complete`마다 `onChange()`를 인자 없이 호출한다. `error`는 알림으로만 쓰고 삼킨다 — 다시 던지지 않는다. 반환 함수는 그 구독을 해제한다.
- `getSnapshot`은 캐시하지 않는다. 호출 시점의 `state.snapshot`을 그대로 돌려준다.
- `WeakMap` 캐시로 같은 `state` 객체에는 같은 store(같은 `subscribe`·`getSnapshot` 함수 참조)를 돌려준다. React는 `useCallback` 없이 `useSyncExternalStore(store.subscribe, store.getSnapshot)`로 쓴다.
- store 함수는 `this`를 쓰지 않는 closure로 만들고, store 객체는 `Object.freeze`한다(ADR 0021의 API 트리 동결과 같은 취지 — React가 `subscribe`·`getSnapshot`을 분리해서 호출한다).
- 원격 complete/error 뒤에는 재구독하지 않는다. snapshot은 `stale`(또는 `uninitialized`)에서 멈춘다.
- 입력은 공개 인터페이스 `RemoteState<T>`다. `RemoteState`·`RemoteStateSnapshot` 타입은 바뀌지 않는다.

### 범위 해석

ROADMAP "현재 범위 밖의 확장"은 "React 전용 패키지"를 제외한다. 이 제외는 유지한다. `snapshotStore`는 프레임워크 중립 adapter이고 React 의존성을 만들지 않는다 — README의 React 레시피는 사용자 코드로 예시일 뿐 패키지 의존성이 아니다. 따라서 이 adapter와 레시피는 "React 전용 패키지" 제외에 해당하지 않는다.

## 대안과 기각 사유

- **`/react` subpath(React를 optional peerDep으로).** peerDep 관리, 별도 export 조건, 버전 호환 표가 늘어난다. `snapshotStore`는 React를 참조하지 않는 순수 함수라 subpath가 필요 없다.
- **별도 패키지(`@cp949/rx-bridge-electron-react`).** 발행·버전 동기화 비용이 생긴다. adapter 자체가 프레임워크 중립이라 분리할 이유가 없다.
- **`RemoteState`에 메서드 추가(`state.toStore()` 등).** `RemoteState`는 공개 인터페이스이므로 사용자가 만드는 fake·mock도 새 메서드를 구현해야 한다. 독립 함수로 두면 `RemoteState<T>` 모양만 만족하면 된다.
- **캐시 없는 함수(매 호출 새 store 생성).** React에서 안정된 참조를 얻으려면 호출부가 `useMemo`/`useCallback`을 직접 써야 해 hook 작성 부담이 그대로 남는다. `WeakMap` 캐시가 이 부담을 adapter 쪽으로 옮긴다.
- **자동 재구독.** 결정 2("종료 후")를 반복 위반한다. 원격 종료는 ADR 0020이 정한 최종 상태이고, 자동 재구독은 그 계약과 충돌한다.
- **snapshot에 error 추가.** `RemoteStateSnapshot`은 공개 계약이다. error를 실으려면 모든 소비자가 새 판별 분기를 갖게 되고, ROADMAP 결정("종료 원인은 노출하지 않는다")과도 어긋난다. 원인이 필요하면 `state`를 직접 구독한다.

## 한계

- 종료 원인을 store로 알 수 없다. `RemoteError`가 필요하면 `state.subscribe({ error })`로 직접 구독한다.
- 종료 뒤 자동 복구가 없다. 다시 구독하려면 컴포넌트를 remount하거나 새 `state`를 넘긴다.

## 범위 밖

Event·RPC 편의 기능, TanStack Query 연동 예제 문서화. 후속 이슈로 `.scratch/renderer-framework-integration/issues/`에 등록한다(TanStack은 demo 의존성에 넣지 않고 문서 예제로만 둔다).
