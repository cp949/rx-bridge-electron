# ADR 본문·코드 주석의 현재 코드 불일치

- Status: open
- 출처: 2026-09-26 `docs/design/` 작성 중 코드 대조(`dev` @ `f261fce` 기준).

설계 문서 작성 중 코드 대조로 확인. 설계 문서는 코드 기준으로 썼다. ADR은 기록이므로 본문을 고치지 않고 개정 note를 붙일지 판단한다.

- ADR 0003: "계약에 선언된 유한 버퍼" — buffer는 source 생성 옵션(ADR 0012).
- ADR 0004: "Electron 어댑터와 preload는 envelope 구조만 검사" — 어댑터는 parse하지 않는다(ADR 0016). 상단 개정 note에 없음.
- ADR 0006: `establish()`·`current()`가 `undefined` 반환 — 현재 `{ reason }` Admission. dispose 뒤 handshake 거부를 adapter `protocolError` 폴백이 만든다 — 실제는 `server.handshake`가 `invalidRequest` 반환. RPC dispose 순서에 `rpc-settled` 선기록 누락.
- ADR 0007: 빈 종류는 "타입에도 키가 없다" — `BridgeApi<B>`는 빈 카테고리 레코드(`rpc: {}`)에 `rpc` 키를 만든다(런타임은 `undefined`).
- ADR 0009: 결정 2·12의 `createBridgeServer(contract, implementations)`·`contract.payloadLimits`·adapter envelope 검사. 결정 10 "취소나 deadline으로 응답을 먼저 보내도"(Renderer cancel·retire 때 Main은 응답을 먼저 보내지 않는다). 결정 11 "NOT_FOUND 거부가 slot 즉시 반환"(NOT_FOUND는 slot 획득 전). "신뢰 경계 밖 코드가 아니다"가 ADR 0016 "Renderer는 신뢰 경계 밖"과 충돌.
- ADR 0012·README: "초과 operation은 컴파일 타임 실패" — fresh object literal에만 해당(excess property check).
- ADR 0014: "retire는 `session.signal` abort 이벤트 하나로" — `onRetire` interface(ADR 0023).
- ADR 0015 "틀렸을 때의 대가": FakeTarget frameId 미비교 서술 — 현재 비교한다.
- ADR 0017: loopback `dispose()` ≈ `destroyed` — 실제 detach(CANCELLED 통지, retired 기록 남음). "양방향 structuredClone" — handshake·cancel·control 요청은 새 객체 조립.
- ADR 0024: "값이 바뀔 때만 새 snapshot 객체" — `next`마다 새 객체.
- `src/main/protocol-error.ts` 머리 주석: "타입 전용 import만", "`electron-adapter.ts`가 preload 번들에 들어간다" — 둘 다 낡음.
- test 제목 "알 수 없는 key는 NOT_FOUND 뒤 슬롯이 반환된다" — slot을 쓰지 않는다.

## Comments
