# `authorize`의 두 번째 인자를 wire key 문자열에서 구조화 객체 `BridgeOperation`으로 바꾼다

- 관련: ROADMAP.md#RD-024

## 상황

`Authorize = (context, operationId: string)`은 wire key(`category:domain/op`) 문자열을 받았다. 형식은 공개 문서에 없었고, 사용자 코드가 문자열을 직접 잘랐다 — demo는 `key.startsWith("state:") || key.startsWith("event:")`로, README 예시는 `!operation.startsWith("rpc:")`로 카테고리를 판정했다. 형식이 바뀌어도 타입이 잡아 주지 않는다.

`authorize`는 등록 조회를 통과한 key만 받는다([ADR 0014](0014-stream-lookup-before-authorize.md), [ADR 0015](0015-rpc-request-lifecycle.md)). 호출 시점에 Main은 이미 등록 entry(카테고리·도메인·operation)를 갖고 있다 — 분해할 정보를 새로 계산할 필요가 없다.

## 결정: 두 번째 인자를 `BridgeOperation`으로 교체한다

```ts
type OperationCategory = "rpc" | "state" | "event";

interface BridgeOperation {
  readonly key: string; // "rpc:device/connect"
  readonly category: OperationCategory; // "rpc"
  readonly domain: readonly string[]; // ["device"], 중첩이면 ["a", "b"]
  readonly operation: string; // "connect"
}

type Authorize = (
  context: BridgeContext,
  operation: BridgeOperation,
) => boolean | Promise<boolean>;
```

- 문자열 인자는 남기지 않는다(교체). 같은 정보를 두 경로로 주면 어느 쪽을 써야 하는지 모호해지고, 문자열 파싱 경로가 계속 열려 있다.
- key 전체 비교가 필요한 코드는 `operation.key`를 쓴다.
- 필드 이름은 `category`다. `CONTEXT.md`와 key 문법 모듈(`protocol/operation-key.ts`)의 용어를 따른다. 내부 등록 entry의 `kind`는 공개 이름이 아니다.
- `domain`은 segment 배열이다. `"a/b"` 문자열이면 "admin 아래 전부" 같은 판정에 다시 문자열 파싱이 필요하다. 배열이면 `domain[0] === "admin"`이다.
- `BridgeOperation`과 `OperationCategory`는 `@cp949/rx-bridge-electron/main`에서 type export한다. `authorize`는 Main 전용이다.

## 결정: 등록 시 entry마다 한 번 만들고 동결한다

`createBridgeServer`가 impl 트리를 순회해 등록 entry를 만들 때 `BridgeOperation`을 함께 만들어 객체와 `domain` 배열을 `Object.freeze`한다. RPC(`RpcRequests`)와 stream(`Subscriptions`) 호출 지점은 조회한 entry의 객체를 그대로 넘긴다 — 요청마다 할당하지 않는다.

공개 계약은 "동결된 객체"까지다. 같은 operation이면 같은 객체라는 동일성(`===`)은 약속하지 않는다 — 구현 세부다. 비교는 `key`로 한다.

## 기각한 대안

- **`protocol/operation-key`의 `parseWireKey`를 공개 export.** 인자는 그대로 두고 사용자가 분해한다. `parseWireKey`는 verdict(`ok: false` + reason)를 반환하는데 `authorize`는 등록된 key만 받으므로 그 실패 분기는 쓰일 일이 없다. 쓰이지 않는 분기가 공개 계약이 되고, RD-017의 비공개 결정을 뒤집는다.
- **형식만 문서화.** 문자열 파싱이 사용자 코드에 남고 타입 보장이 없다.
- **세 번째 인자로 추가(`(context, key, operation)`).** 기존 코드는 안 고쳐도 되지만 같은 정보가 두 번 들어온다. 외부 사용 이력이 없어 교체 비용이 저장소 안에 한정된다.

## 보존

- 진단 이벤트(`BridgeDiagnostic`)의 `key`는 wire key 문자열 그대로다. 진단은 로그·모니터링용이라 문자열이 저장·출력에 적합하고, 진단에서 문자열을 파싱하는 사용처는 확인되지 않았다.
- `protocol/operation-key.ts`는 계속 비공개다. `./protocol`은 `OperationCategory`를 re-export하지 않는다.
- `authorize` 호출 순서(등록 조회 → 슬롯 → `authorize`), 미등록 key의 `NOT_FOUND`([ADR 0014](0014-stream-lookup-before-authorize.md)), 예외·reject의 `INTERNAL`([ADR 0011](0011-authorize-exception-internal.md)), abort 시 `CANCELLED` 우선([ADR 0015](0015-rpc-request-lifecycle.md)), 와이어 형식은 바뀌지 않는다.
