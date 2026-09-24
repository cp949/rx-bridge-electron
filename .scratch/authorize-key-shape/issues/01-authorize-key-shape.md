Status: 후보 (RD-017에서 범위 제외)

# `authorize`의 key 인자 형식

`Authorize = (context, operationId: string)`는 wire key(`category:domain/op`)를 받지만 형식이 문서화되어 있지 않다. 사용자 코드가 문자열을 직접 파싱한다 — demo `apps/demo/src/main/composition.ts:20-23` `key.startsWith("state:") || key.startsWith("event:")`.

선택지:

- 구조화 인자(`{ category, domain, operation, key }`)를 넘긴다 — 공개 API 변경(breaking, npm 배포 이력 없음).
- `protocol/operation-key`의 `parseWireKey`를 공개 export한다 — 공개 API 증가.
- 형식만 문서화한다.

RD-017은 코어를 비공개로 두었다(결정 2). 이 결정은 공개 계약을 바꾸므로 별도 ADR이 필요하다.

## Comments

- 2026-09-24: RD-017 DELTA-06에서 `_works/20260924-11-operation-key-grammar/pending-issues/01-authorize-key-shape.md`로부터 등록. 내용은 그대로 옮김 — 여전히 후보 상태이고 결정은 이 작업 범위 밖이다.
