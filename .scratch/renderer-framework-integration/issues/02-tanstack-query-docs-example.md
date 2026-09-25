# TanStack Query 연동 문서 예제

- Status: closed — 패키지 README "TanStack Query 연동" 절에 반영
- 출처: 2026-09-25 그릴링(사용자 요청: "TanStack Query 연동 같은 실제 예제코드도 필요하다, 문서화만").

## 범위

- README(또는 별도 문서)에 RPC를 `queryFn`·`mutationFn`으로 쓰는 예제.
- `AbortSignal` 전달(`CallOptions.signal`)을 보여준다.
- `RemoteError.code` 기반 retry 판정을 보여준다.

## 제약

- demo·패키지 의존성에 TanStack Query를 넣지 않는다.
- 예제는 문서로만 둔다.
- 검증 수단이 없다는 점을 문서에 적을지 결정한다.

## Comments

- 2026-09-26: 패키지 README "프레임워크 연동" 뒤에 "TanStack Query 연동" 절을 추가했다. `queryFn`의 `signal` 전달, `RemoteError.code` 기반 retry 판정(`RESOURCE_EXHAUSTED`·`DEADLINE_EXCEEDED`만 재시도), mutation 재시도 비권장, `retryDelay` 0 금지를 다룬다. 검증 수단 결정: 검증 범위를 문서에 적는다. `@tanstack/react-query` 5.103.2로 타입 검사(`tsc` exit 0), `@tanstack/query-core` 5.103.2 + `createLoopbackTransport` + 실제 server로 1회 실행했다. 실측: 성공 1건, `cancelQueries` 뒤 handler `signal.aborted === true`·query `status: "pending"`·`error: null`, 재시도 포함 실패 횟수 `FORBIDDEN` 1·선언 도메인 코드 1·`DEADLINE_EXCEEDED` 4·`RESOURCE_EXHAUSTED` 4. 부수 발견: `maxConcurrentRpc: 1`, `retryDelay: 0`에서 `AbortSignal`을 무시하는 handler 뒤의 즉시 재시도는 `DEADLINE_EXCEEDED` 대신 `RESOURCE_EXHAUSTED`로 끝났다(slot은 handler 종료 때 반환, ADR 0015). 이 내용을 README에 "재시도 간격" 항목으로 적었다. 검증 스크립트는 로컬 `_works/_completed/20260926-02-tanstack-query-docs/`에 있다(git 추적 제외). 저장소 test·CI·의존성에는 추가하지 않았다.
