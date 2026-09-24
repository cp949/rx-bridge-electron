Status: 승격 (ROADMAP.md#RD-024)

# `authorize`의 key 인자 형식

`Authorize = (context, operationId: string)`는 wire key(`category:domain/op`)를 받지만 형식이 문서화되어 있지 않다. 사용자 코드가 문자열을 직접 파싱한다 — demo `apps/demo/src/main/composition.ts:20-23` `key.startsWith("state:") || key.startsWith("event:")`.

선택지:

- 구조화 인자(`{ category, domain, operation, key }`)를 넘긴다 — 공개 API 변경(breaking, npm 배포 이력 없음).
- `protocol/operation-key`의 `parseWireKey`를 공개 export한다 — 공개 API 증가.
- 형식만 문서화한다.

RD-017은 코어(`src/protocol/operation-key.ts`)를 비공개로 두었다. 이 결정은 공개 계약을 바꾸므로 별도 ADR이 필요하다.

## Comments

- 2026-09-24: RD-017 마무리에서 등록. 후보 상태이고 결정은 RD-017 범위 밖이다.
- 2026-09-25: 설계 인터뷰에서 결정. 첫 번째 선택지(구조화 인자)를 교체 방식으로 채택했다 — `Authorize = (context, operation: BridgeOperation)`, `{ key, category, domain: readonly string[], operation }`, 등록 시 동결 객체 1회 생성, `./main` type export. 진단 `key`는 문자열 유지, `operation-key.ts`는 비공개 유지, 외부 사용 이력이 없어 이전 안내 없음. ROADMAP.md#RD-024로 승격, 근거는 [ADR 0018](../../../docs/adr/0018-authorize-structured-operation.md).
