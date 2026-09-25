# Main은 렌더러 문서 세션별로 진행 중 RPC 수·구독 수·RPC 실행 시간·payload 전체 크기를 제한한다

## 상황

Main에는 RPC timeout이 없었다(Renderer `rpc-client.ts`의 로컬 30초 timeout만 존재하고, 만료 시 best-effort `cancel`만 보낸다). 진행 중 RPC 수와 구독 수에도 상한이 없었다. `DocumentSessions`의 `usedStreamIds`(세션별 Set)와 `StreamHub`의 `#used`/`#usedBySession`은 세션 수명 동안 계속 커졌다. `#retiredClients`는 삭제 경로가 없어 무한히 쌓였다. payload 크기 검사는 깊이·항목 수·문자열 길이만 있고 전체 크기 한도가 없어 큰 배열이나 bigint를 통해 메모리를 소모시킬 수 있었다. 이 모든 자원은 세션(연결된 `webContents`의 현재 main-frame 문서) 단위로 공유되지 않지만 프로세스는 공유하므로, 한 세션이 자원을 소진하면 다른 세션의 정상 요청도 영향을 받을 수 있었다. [RD-006](../history/roadmap.md).

## 결정

1. **적용 위치**: 모든 자원 한도는 Main만 강제한다. Renderer는 받은 오류를 그대로 전달하고 사전 차단하지 않는다.
2. **설정 위치**: 자원 한도는 `createBridgeServer(contract, implementations, { resourceLimits })` 서버 옵션이다. 계약(`composeContracts`)에는 두지 않는다 — 자원 한도는 배포 환경의 운영 판단이지 도메인 계약의 일부가 아니다.
3. **오류 코드**: 개수·동시성 초과(`maxConcurrentRpc`, `maxSubscriptions`)는 새 코드 `RESOURCE_EXHAUSTED`. 입력 크기 초과는 기존 `INVALID_ARGUMENT`, 출력(RPC 결과·stream 값·도메인 에러 details) 크기 초과는 기존 `INTERNAL`(ADR 0004의 출력 검증 실패 분류를 따른다).
4. **timeout 상한**: Main 서버 옵션 `maxRpcDurationMs`. 만료 시 handler에 넘긴 `AbortSignal`을 abort하고 `DEADLINE_EXCEEDED`로 즉시 응답한다. 와이어 프로토콜과 Renderer `timeoutMs`(`rpc-client.ts`의 로컬 timeout)는 바꾸지 않는다 — 둘은 독립적으로 동작하며 먼저 확정되는 쪽이 이긴다.
5. **전체 크기**: `PayloadLimits.maxTotalBytes`(선택 필드). `parseBridgeValue` 순회 중 근사 byte를 누적해 초과 시 즉시 실패시킨다.

   _(개정: RD-038 — 서버 옵션 `payloadLimits`에서 `maxTotalBytes`에 명시적 `undefined`를 넣으면 다른 세 필드와 같이 생성 시점에 `TypeError`다. 이전에는 통과해 기본값 16 MiB를 지우고 전체 크기 검사를 껐다. 필드의 선택성은 `PayloadLimits` 타입에 남는다 — 서버가 해석한 한도(`resolvePayloadLimits`, `packages/rx-bridge-electron/src/main/payload-limits.ts`)는 네 필드가 항상 있고, 선택성은 envelope parse 단계(`ENVELOPE_LIMITS`)가 전체 크기 무제한을 표현하는 데만 쓰인다. 무제한이 필요하면 `Number.MAX_SAFE_INTEGER`를 쓴다.)_

6. **사용 완료 stream ID**: 세션별 워터마크(마지막으로 수락한 subscriptionId sequence). `subscriptionId`에서 sequence를 파싱해 워터마크보다 큰 것만 받는다. `DocumentSessions.usedStreamIds`와 `StreamHub`의 `#used`/`#usedBySession`/`#reserve`를 대체한다.
7. **retired clientId**: `destroyed` 수명 사건에 해당 `webContentsId` 기록 전체를 삭제한다. 살아 있는 `webContents`에서는 최근 `maxRetiredClientsPerWebContents`개만 보관한다(초과 시 가장 오래된 항목부터 제거). ADR 0006의 "retire된 client ID 기록은 서버 dispose 후에도 지우지 않는다" 문구를 이 규칙으로 갱신한다.
8. **범위**: 세션별 한도만 둔다. 서버 전역(모든 세션 합계) 상한은 두지 않는다.
9. **기본값**: 아래 표. 모두 `resourceLimits` 옵션으로 개별 덮어쓸 수 있다.
10. **RPC 슬롯 반환**: 취소나 deadline으로 응답을 먼저 보내도, handler Promise가 실제로 끝날 때(resolve/reject) 슬롯을 반환한다. `AbortSignal`을 무시하는 handler는 자기 세션의 슬롯만 계속 점유하며 다른 세션에 영향을 주지 않는다.
11. **구독 계산**: 대기(`authorize` 중)와 활성을 합쳐 `maxSubscriptions` 하나로 센다. unsubscribe·거부(`FORBIDDEN`/`NOT_FOUND`/`authorize` 예외)·세션 retire 경로는 슬롯을 즉시 반환한다. 완료·오류·overflow(source 쪽 종료)는 source를 즉시 분리하되 대기 값을 ack 순서대로 모두 전달한 뒤 terminal을 보내고 그 뒤 슬롯을 반환한다(RD-009에서 문구 정정 — 동작은 처음부터 이 순서였다. 이전 문구는 모든 경로를 "즉시 반환"으로 적었다). 초과 시 `subscribed` 다음 `RESOURCE_EXHAUSTED` `error`를 보낸다.
12. **payload 한도 적용 지점**: `electron-adapter.ts`와 `preload/expose-bridge.ts`는 envelope 구조(깊이·항목 수·문자열 길이 모두 `Number.MAX_SAFE_INTEGER`)만 검사하고 payload 한도는 강제하지 않는다. payload 한도는 서버가 계약 기준(`contract.payloadLimits`와 기본값의 병합)으로만 적용한다. 계약이 기본값보다 큰 한도를 선언하면 그 한도가 adapter를 거쳐 handler까지 실제로 적용된다.
13. **ID 계약**: 워터마크 대상은 stream `subscriptionId`뿐(RPC `requestId`는 대상이 아니다). 형식은 `<nonce>:<scope>:<seq base36>`(`src/renderer/ids.ts`의 `createOpaqueId` 산출 형식, `src/protocol/opaque-id.ts`의 `parseOpaqueIdSequence`가 파싱한다). 형식 오류는 `INVALID_ARGUMENT`로 reject한다. 워터마크 이하(재사용·늦은 도착)는 메시지 없이 조용히 무시한다.

_(개정: RD-049 — 결정 2·10·11·12의 일부 서술은 현재 코드와 다르다. 결정 자체(적용 위치, 오류 코드, slot 계산 단위)는 그대로다. 항목별 차이는 아래와 같다.)_

- 결정 2·12: 서버 생성은 `createBridgeServer(impl, options)`이고 payload 한도 기준은 `options.payloadLimits`와 기본값의 병합이다([ADR 0012](0012-lightweight-type-contract.md)). 결정 12의 "adapter는 envelope 구조만 검사"는 [ADR 0016](0016-sender-admission.md) 이후 맞지 않다 — adapter는 parse하지 않고 server가 parse한다. preload는 크기 한도 없이 구조만 검사한다.
- 결정 10: 응답을 먼저 보내는 것은 deadline뿐이다. Renderer `cancel`과 세션 retire는 handler에 넘긴 `AbortSignal`만 abort하고, 응답(`CANCELLED`)은 handler가 끝날 때 보낸다. 그보다 deadline이 먼저 오면 그 시점에 `CANCELLED`로 보낸다(`src/main/rpc-requests.ts`의 `dispatch`). slot을 handler 종료 때 반환한다는 규칙은 그대로다.
- 결정 11: `NOT_FOUND`는 slot을 즉시 반환하는 경로가 아니라 slot을 잡기 전에 끝난다. [ADR 0014](0014-stream-lookup-before-authorize.md)가 등록 조회를 slot 획득 앞으로 옮겼다. RPC도 같다([ADR 0015](0015-rpc-request-lifecycle.md)).

### 기본값

| 옵션                              | 기본값     | 비고                                                        |
| --------------------------------- | ---------- | ----------------------------------------------------------- |
| `maxConcurrentRpc`                | 64         | 세션당 동시 진행 중 RPC 수                                  |
| `maxSubscriptions`                | 256        | 세션당 대기+활성 구독 수                                    |
| `maxRpcDurationMs`                | 300,000    | `Infinity` 지정 시 deadline 없음, 유한값 최대 2,147,483,647 |
| `maxRetiredClientsPerWebContents` | 32         | `webContents`별 retired clientId 보관                       |
| `PayloadLimits.maxTotalBytes`     | 16,777,216 | 16 MiB, 근사 byte 합계                                      |

## 대안과 기각 사유

- **Renderer가 사전 차단**: Renderer는 신뢰 경계 밖에 있는 코드가 아니지만, 여러 Renderer 프로세스가 Main 자원을 공유하는 구조상 강제 지점은 공유 자원을 실제로 쥔 Main이어야 한다. Renderer 쪽 차단은 우회 가능한 힌트일 뿐이라 채택하지 않았다.

_(개정: RD-049 — "Renderer는 신뢰 경계 밖에 있는 코드가 아니지만"은 [ADR 0016](0016-sender-admission.md)의 "Renderer는 신뢰 경계 밖"과 충돌한다. 현재 기준은 후자다. Main이 강제 지점이어야 한다는 기각 근거는 그대로 성립한다 — Renderer 쪽 차단은 우회할 수 있다.)_

- **계약에 자원 한도를 둔다**: `payloadLimits`처럼 계약 단위로 두면 도메인 작성자가 배포 환경의 동시성·시간 상한까지 결정하게 된다. 자원 한도는 서버를 띄우는 쪽(운영자)의 책임이라 서버 생성 옵션으로 분리했다.
- **와이어 프로토콜에 `timeoutMs`를 싣는다**: Main deadline은 Renderer의 로컬 timeout과 독립적으로 동작해도 충분하다 — 둘 중 먼저 확정되는 응답이 이긴다. 프로토콜을 바꾸면 기존 transport 구현체와의 호환성이 깨진다.
- **FIFO used-ID 목록**: 사용한 ID를 유한 크기 FIFO 큐로 보관하는 방식도 검토했으나, 큐가 가득 차면 오래된 항목이 빠져나가 그 ID가 다시 유효해지는 재사용 윈도우가 생긴다. 워터마크는 순서가 보장되는 한 채널(`channels.control`)에서 도착 순서와 생성 순서가 같다는 전제로 O(1) 메모리와 완전한 재사용 차단을 동시에 만족한다.
- **서버 전역 상한**: 여러 세션의 합계에 상한을 두면 한 세션의 정상적인 사용량이 다른 세션에 의해 거부될 수 있어, "한 세션의 과부하가 다른 세션을 막지 않는다"는 목표와 충돌한다. 세션별 한도만으로 이 목표를 달성한다.

## 한계

- Electron IPC는 구조화된 데이터로 역직렬화를 마친 뒤에야 `parseBridgeValue`가 실행되므로, `maxTotalBytes`는 IPC 수신 메모리 자체를 막지 못한다. 이 한도가 막는 범위는 handler 이후의 처리와 전파(handler로의 전달, 출력 직렬화, Renderer 전달)다.
- 전체 크기는 근사값이다(노드마다 8 byte, 문자열은 UTF-8 byte 길이, bigint는 16진수 자릿수 기반 근사). 실제 V8 structured clone 크기와는 다를 수 있다.
- `webContents` 하나에서 `maxRetiredClientsPerWebContents`보다 오래된 retired clientId는 기록에서 빠진다. 그 시점 이후 같은 clientId 재사용을 막는 것은 워터마크가 아니라 `establish()`의 frame·origin 검사다(오래된 문서는 이미 현재 main frame이 아니므로 그 검사가 먼저 막는다).

## 범위 밖

서버 전역(모든 세션 합계) 상한, Renderer 쪽 사전 차단, 와이어 `timeoutMs`, RPC `requestId` 워터마크, IPC 역직렬화 단계의 수신 메모리 제한, 진단 지표 추가(RD-007, [ADR 0010](0010-operational-diagnostics.md)), 실제 Electron 다중 창·장시간 검증(RD-008, [결과](../verification/rd-008.md)).
