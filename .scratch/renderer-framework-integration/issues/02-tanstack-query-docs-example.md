# TanStack Query 연동 문서 예제

- Status: open
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
