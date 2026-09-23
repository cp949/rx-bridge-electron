# Main은 렌더러 문서 세션별로 진행 중 RPC 수·구독 수·RPC 실행 시간·payload 전체 크기를 제한한다

> 초안(DELTA-01). 결정 골격만 담는다. 세부 문구·표·대안 비교·grep 근거는 DELTA-07에서 구현과 대조해 확정한다.

## 상황

Main에는 RPC timeout이 없고(Renderer `rpc-client.ts`의 로컬 30초 timeout만 존재), 진행 중 RPC 수·구독 수 상한이 없다. `usedStreamIds`(세션)와 `StreamHub`의 `#used`/`#usedBySession`은 세션 수명 동안 계속 커진다. `#retiredClients`는 삭제 경로가 없다. payload 크기 검사는 깊이·항목 수·문자열 길이만 있고 전체 크기 한도가 없다. 한 세션이 이 자원을 소진하면 다른 세션의 정상 요청도 영향을 받을 수 있다. ROADMAP RD-006.

## 결정 요약

1. 모든 자원 한도는 Main만 강제한다. Renderer는 받은 오류를 그대로 전달한다.
2. 자원 한도는 `createBridgeServer(..., { resourceLimits })` 서버 옵션이다. 계약에 두지 않는다.
3. 개수·동시성 초과는 새 코드 `RESOURCE_EXHAUSTED`. 입력 크기 초과는 `INVALID_ARGUMENT`, 출력(RPC 결과·stream 값·도메인 에러 details) 크기 초과는 `INTERNAL`.
4. Main 서버 옵션 `maxRpcDurationMs`. 만료 시 handler `signal`을 abort하고 `DEADLINE_EXCEEDED`로 응답한다. 와이어 프로토콜과 Renderer `timeoutMs`는 바꾸지 않는다.
5. `PayloadLimits.maxTotalBytes`(선택 필드). `parseBridgeValue` 순회 중 근사 byte를 누적한다.
6. 사용 완료 stream ID는 세션별 워터마크(sequence 파싱)로 판정한다. `usedStreamIds`와 `StreamHub`의 used-ID 저장소를 대체한다.
7. retired clientId는 `destroyed` 수명 사건에 해당 webContentsId 기록을 삭제한다. webContents별 최근 N개만 보관한다.
8. 세션별 한도만 둔다. 서버 전역 상한은 두지 않는다.
9. 기본값: `maxConcurrentRpc` 64, `maxSubscriptions` 256, `maxRpcDurationMs` 300,000, `maxTotalBytes` 16 MiB, retired 보관 32. 모두 덮어쓸 수 있다.
10. RPC 슬롯은 handler Promise가 끝날 때까지 점유한다(응답이 먼저 나가도 마찬가지).
11. 구독은 대기(authorize 중)+활성을 합쳐 한 상한으로 센다. 초과 시 `streams.reject()`로 `RESOURCE_EXHAUSTED`.
12. payload 한도는 서버가 계약 기준으로만 적용한다. adapter·preload는 구조 검사만 한다.
13. 워터마크 대상은 stream `subscriptionId`뿐. 형식은 `<nonce>:<scope>:<seq base36>`. 형식 오류는 `INVALID_ARGUMENT`, 워터마크 이하는 조용히 무시한다.

## 한계 (골격)

- Electron IPC 역직렬화 이후에만 검사하므로 `maxTotalBytes`는 수신 메모리 자체를 막지 못한다.
- 전체 크기는 근사값이다(실제 structured clone 크기와 다를 수 있다).
- webContents 하나에서 N개보다 오래된 retired clientId는 기록에서 빠진다. 재사용 방지는 frame·origin 검사에 의존한다.

## 범위 밖

서버 전역(모든 세션 합계) 상한, Renderer 쪽 사전 차단, 와이어 `timeoutMs`, RPC `requestId` 워터마크, IPC 역직렬화 단계의 수신 메모리 제한, 진단 지표(RD-007), 실제 Electron 다중 창·장시간 검증(RD-008).

## 이전(migration) (골격)

DELTA-07에서 README "호환성 변경" 절과 대조해 확정한다.
