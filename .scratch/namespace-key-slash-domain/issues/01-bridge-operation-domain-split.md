# impl namespace 키에 `/`가 있으면 `BridgeOperation.domain`이 분해되지 않는다

- Status: closed — 후보 (1)(namespace 키의 `/` 거부) 적용. 옵션 트리 키의 `/`도 거부
- 출처: 2026-09-26 `docs/design/` 작성 중 코드 대조(`dev` @ `f261fce` 기준).

- 사실: `{ "a/b": { rpc: { x } } }` impl은 segment별 검사를 통과하고 wire key `rpc:a/b/x`로 등록된다. `BridgeOperation.domain`은 `["a", "b"]`가 아니라 `["a/b"]`다. 중첩 객체 `{ a: { b: { rpc: { x } } } }`는 `["a", "b"]`.
- 영향: `authorize`가 `domain[0] === "a"`로 판정하면 두 형태가 다르게 인가된다. wire key는 같다.
- 후보: (1) namespace 키의 `/`를 거부 (2) `/`로 나눠 domain 배열을 만든다 (3) 문서화만.
- 계약 타입(중첩 객체)을 따르면 발생하지 않는다. 타입 우회 또는 문자열 키 사용 시만.

## Comments

- 2026-09-26: 후보 (1) 적용. `registration.ts`의 `assertPathSegments`(키를 `/`로 나눠 조각별 검사)를 `assertNamespaceKey`(`/`가 있으면 `Domain name segment '<key>' cannot contain '/'.`, 없으면 키 하나를 `checkSegment`)로 바꿨다. 적용 중 같은 원인의 결함 1건을 추가로 발견했다. `options.schemas`·`options.errors`의 `{ "a/b": { rpc: { x } } }`나 operation 이름 `"b/x"`는 wire key가 impl `{ a: { b: { rpc: { x } } } }`와 같아 `assertNoExtraOptionPaths`의 경로 조회를 통과하지만 impl 순회는 중첩 경로만 읽으므로 schema·errors가 조용히 무시됐다. 옵션 트리의 namespace 키·operation 이름에도 `/`를 거부한다(`options.schemas key '<key>' cannot contain '/'.`). test: `create-bridge-server-impl.test.ts`에 impl 2건·옵션 3건 추가, 기존 `"sub/rpc"` 예약어 case는 `/` 거부가 먼저 걸리므로 제거. 문서: `docs/design/01-contract.md`(순회 3단계·옵션 순회·메시지 표·한계 항목 삭제), `docs/architecture.md`, 패키지 README. 검증: 패키지 `pnpm verify`(45 files·873 tests), 루트 `pnpm lint`·`pnpm format:check` 통과.
