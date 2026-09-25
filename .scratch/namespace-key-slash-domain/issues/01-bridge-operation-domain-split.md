# impl namespace 키에 `/`가 있으면 `BridgeOperation.domain`이 분해되지 않는다

- Status: open
- 출처: 2026-09-26 `docs/design/` 작성 중 코드 대조(`dev` @ `f261fce` 기준).

- 사실: `{ "a/b": { rpc: { x } } }` impl은 segment별 검사를 통과하고 wire key `rpc:a/b/x`로 등록된다. `BridgeOperation.domain`은 `["a", "b"]`가 아니라 `["a/b"]`다. 중첩 객체 `{ a: { b: { rpc: { x } } } }`는 `["a", "b"]`.
- 영향: `authorize`가 `domain[0] === "a"`로 판정하면 두 형태가 다르게 인가된다. wire key는 같다.
- 후보: (1) namespace 키의 `/`를 거부 (2) `/`로 나눠 domain 배열을 만든다 (3) 문서화만.
- 계약 타입(중첩 객체)을 따르면 발생하지 않는다. 타입 우회 또는 문자열 키 사용 시만.

## Comments
