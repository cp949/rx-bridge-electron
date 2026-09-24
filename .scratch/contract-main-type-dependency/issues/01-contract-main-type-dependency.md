Status: 후보 (RD-023에서 범위 제외)

# `contract`가 `main`의 타입을 import한다

`src/contract/bridge-types.ts`는 `BridgeImpl<B>`를 정의하려고 `../main/sources.js`의 `CurrentValueSource`·`EventSource`와 `../main/types.js`의 `BridgeContext`를 type import한다. 모든 프로세스가 쓰는 `contract` 계층이 Main 계층에 기대는 방향이다.

현재 영향:

- type-only라 런타임·번들 영향은 0이다. eslint `no-restricted-imports`는 `allowTypeImports: true`로 이를 허용한다.
- `@cp949/rx-bridge-electron/contract`의 d.ts가 Main 타입 선언을 함께 끌어온다.

선택지:

- `BridgeImpl`이 참조하는 타입(`CurrentValueSource`, `EventSource`와 그 구성 타입 `BroadcastEventSource`·`ScopedEventSource`·`EventSourceBuffer`·`OverflowPolicy`, `BridgeContext`)을 `contract`로 옮기고 `main`이 re-export한다. 공개 export 이름은 유지된다.
- `BridgeImpl`을 `main`으로 옮기고 `contract`에서 re-export만 한다. 역의존은 re-export 경로로 남는다.
- 그대로 둔다(type-only 역의존 허용을 architecture 문서에 명시).

## Comments

- 2026-09-25: RD-023 마무리에서 등록. 삭제가 아니라 타입 소유 위치를 정하는 설계 결정이라 RD-023 범위 밖이다.
