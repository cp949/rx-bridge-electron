Status: closed — 선택지 1(타입을 `contract`로 옮기고 `main`이 re-export) 적용

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
- 2026-09-25: 선택지 1로 해결. `BridgeContext`·`SenderIdentity`·`CurrentValueSource`·`EventSource`·`BroadcastEventSource`·`ScopedEventSource`·`EventSourceBuffer`·`OverflowPolicy`를 `src/contract/impl-types.ts`로 옮겼다. `main/types.ts`·`main/sources.ts`는 re-export로 기존 import 경로를 유지한다. eslint에 `src/contract/**`의 `src/main/*` import 금지 규칙을 추가했다(`allowTypeImports` 없음). 변경 전후 `dist/*/index.d.ts` 6개 entry의 export 목록이 동일함을 확인했다. 선택지 2는 re-export 경로로 역의존이 남고, 3은 계층 방향을 문서 예외로 남겨 기각했다. 부수 발견: 순환 chunk 경고를 피하려고 barrel 대신 `bridge-types.ts`를 직접 가리킨다는 주석 3곳의 전제가 변경 전 코드에서도 재현되지 않는다 → `.scratch/stale-cycle-chunk-comments/issues/01-stale-cycle-chunk-comments.md`.
