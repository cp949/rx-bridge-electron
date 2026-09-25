Status: closed

# transport.cancel 재진입 시 먼저 발생한 취소 원인 대신 재진입한 원인으로 확정된다

- 출처: RD-021 리뷰(checklist "리뷰 교정", 커밋 `4fc4c85`)

## 현상

`RpcClient.call`의 `cancelOnce`(`packages/rx-bridge-electron/src/renderer/rpc-client.ts:90`)는 `settled`를 확인하고 `transport.cancel(requestId)`를 호출한 뒤 `rejectOnce(error)`(`:102`)로 확정한다. `settled`는 `rejectOnce`에서야 `true`가 된다. 그래서 `transport.cancel`이 같은 호출의 다른 취소 경로(abort signal·dispose)를 동기로 재진입시키면, 재진입한 `cancelOnce`가 먼저 확정한다. 처음 발생한 원인의 error는 버려진다.

재현(fake timer):

1. `transport.cancel`이 cancel을 기록한 뒤 호출에 넘긴 `AbortController`를 `abort()`하는 custom transport.
2. `api.hardware.rpc.connect(input, { signal, timeoutMs: 25 })` 호출 후 25ms 진행.
3. timeout이 먼저 발생했는데 결과는 `DEADLINE_EXCEEDED`가 아니라 `CANCELLED "RPC call was cancelled."`다. cancel 전송은 `cancellationSent` guard 덕분에 1회다.

dispose 경로도 같다(실측: dispose → `transport.cancel` → abort 재진입 → `CANCELLED "RPC call was cancelled."`, dispose 문구 `"Renderer API is disposed."`가 사라짐).

## 영향

- 기본 preload transport의 `cancel`은 `ipcRenderer.send`(`src/preload/expose-bridge.ts:87`), loopback transport의 `cancel`은 `queueMicrotask` 연기(`src/testing/loopback-transport.ts:92`)라 동기 재진입이 없다. `cancel`에서 동기로 호출자 signal을 abort하는 custom transport에서만 나타난다.
- error `code`가 원인과 다르게 보인다. timeout을 재시도 조건으로 쓰는 소비자는 `DEADLINE_EXCEEDED`를 `CANCELLED`로 받아 재시도를 건너뛴다.
- cancel 전송 횟수·timer 정리·listener 해제에는 영향이 없다.

## 선택지(결정: 첫째)

- `cancelOnce`가 `transport.cancel` 호출 전에 확정 원인을 먼저 잡는다(예: `settled = true`와 error를 기록한 뒤 cancel 전송, 마지막에 reject). 먼저 발생한 원인이 이긴다.
- 현재 동작을 유지하고 `BridgeTransport.cancel` 계약에 "동기로 호출자 signal을 abort하지 않는다"를 명시한다.

## 고정 test

`packages/rx-bridge-electron/test/renderer/rpc-calls.test.ts:191` "sends cancel once when transport.cancel re-enters the call's abort"는 등록 당시 cancel 1회와 확정 1회만 단언했다. 해결하면서 `code` 단언을 추가했다(아래 Comments).

## Comments

- 2026-09-24 해결: 선택지 첫째를 적용했다. `cancelOnce`가 `beginSettlement()`로 확정을 먼저 선점한 뒤 `transport.cancel`을 보내고 reject한다. 재진입한 `cancelOnce`는 `settled`에서 바로 반환하므로 `cancellationSent` guard는 도달 불가가 돼 삭제했다. test: timeout 경로 test 제목·단언을 `["DEADLINE_EXCEEDED"]`로 바꾸고, dispose 경로 test("keeps the dispose cause when transport.cancel re-enters the call's abort")를 추가했다. 둘 다 수정 전 RED, 수정 후 GREEN. README RPC 절에 "먼저 일어난 하나만 최종 결과"를 명시했다.
