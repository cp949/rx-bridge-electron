# 계약은 TS 타입 하나로 두고, 스키마는 operation 단위 선택 map으로 둔다

- 관련: RD-010~RD-013, 명세 `.scratch/lightweight-contract/spec.md`
- 대체: [ADR 0004](0004-validated-bounded-payloads.md)의 `payloadLimits` 위치를 개정한다. [ADR 0008](0008-contract-registration-match.md)을 대체한다(런타임 재검증이 필요한 전제 — descriptor 기반 `DomainContract`·`DomainImplementation`·`implementDomain` — 자체가 사라진다).

## 문제

`defineDomain`·`rpc`·`state`·`event`·`composeContracts`·`implementDomain`으로 계약을 선언하면 런타임 descriptor 트리를 만들어야 한다. README 최소 예제(RPC 1개, State 1개)의 계약 파일만 약 33줄이고 그중 약 20줄이 손으로 쓴 스키마다. raw `ipcMain.handle`/`ipcRenderer.invoke`보다 코드가 많아 초기 단계에서 채택할 이유가 약하다. 스키마는 항상 전부 쓰거나 전부 안 쓰는 양자택일이라, 일부 operation에만 검증을 추가하고 싶어도 계약 전체를 스키마 기반으로 다시 써야 한다.

## 결정: 계약은 TS 타입 하나다

계약은 런타임 값이 아니라 타입 `B`다. 계층은 [ADR 0007](0007-hierarchical-renderer-api.md)의 Renderer API 모양(`rpc|state|event`)과 같다.

```ts
type AppBridge = {
  device: {
    rpc: {
      connect(): Connection;
      send(input: { command: string }): SendResult;
    };
    state: { connection: Connection };
    event: { data: SerialLine };
  };
};
```

RPC 인자는 0개 또는 1개다(와이어가 항상 단일 `input`을 실어 나르므로 여러 인자를 받는 형태는 애초에 표현하지 않는다 — RD 분할의 "범위 밖"). 반환은 값 타입(`O`)이며 Renderer에서는 `Promise<O>`가 된다. State는 값 타입, Event는 값 타입의 발생 스트림이다.

**도메인/namespace 구분**: 노드가 `rpc`·`state`·`event` 중 하나라도 키로 가지면 그 노드는 도메인이다. 도메인이 아닌 키는 하위 namespace로 재귀 처리한다(`{ device: { serial: { rpc: {...} } } }`에서 `device`는 namespace, `device.serial`이 도메인). `rpc`·`state`·`event`는 도메인 경로의 모든 segment에서 예약 segment로 유지한다(ADR 0007 규칙 그대로) — 그래야 `api.device.rpc.connect()`처럼 Renderer 호출부에서 종류와 도메인 경로 경계가 흔들리지 않는다.

계약 타입에서 파생하는 타입(`BridgeApi<B>`, `BridgeImpl<B>`, `SchemasFor<B>`, `ErrorsFor<B>`)의 상세 정의는 구현 문서가 아니라 타입 선언 자체(`src/contract/bridge-types.ts`)와 타입 테스트가 규격이다. 이 ADR은 각 타입의 역할만 고정한다.

## 결정: Main 구현은 `createBridgeServer<B>(impl, options)`이고 manifest는 impl 키에서 만든다

`impl: BridgeImpl<B>`은 계약이 선언한 모든 도메인·모든 operation에 대응하는 handler/source를 가진 일반 객체다. 계약과 구현이 어긋나면(누락, 초과, handler·source 형태 오류) 컴파일 타임에 실패한다 — 이것이 [ADR 0008](0008-contract-registration-match.md)이 생성 시점 런타임 재검증으로 잡던 문제(도메인·operation 누락/초과, handler·source 형태 오류)의 자리를 대신한다. `B`와 `impl`은 같은 타입 `B`에서 파생하므로, "같은 이름이지만 다른 정의의 도메인" 같은 참조 불일치 문제 자체가 성립하지 않는다(참조할 별도 `DomainContract` 객체가 없다).

타입을 우회해서(예: `as any`) 만든 impl에 operation이 빠져 있어도 manifest는 impl 키에서 생성하므로 그 operation은 애초에 manifest에 없다 — Renderer에 노출되지 않는다. 이는 "빠진 구현을 던져서 잡는다"가 아니라 "빠진 구현은 노출될 방법이 없다"는 다른 보장이다. impl 런타임 형태 검사(handler가 함수인지, state가 `getValue`를 갖는지 등)는 타입을 우회한 값을 상대로 한 방어선으로 유지한다 — 정상적으로 타입 검사를 통과시켜 만든 impl에서는 발동하지 않는다.

## 결정: `schemas`·`errors`는 계약과 같은 모양의 선택적 중첩 map이다

`options.schemas: SchemasFor<B>`(부분)에 검증하고 싶은 operation만 채운다.

```ts
createBridgeServer<AppBridge>(impl, {
  schemas: { device: { rpc: { send: { input: sendSchema } } } },
});
```

- RPC: `{ input?: Schema<I>; output?: Schema<O> }`. 입력 없는 RPC는 `input` 항목이 없다.
- State·Event: `Schema<T>` 하나.
- 없는 항목은 도메인 스키마 없이 통과한다 — 구조·크기 검사(`parseBridgeValue`)는 스키마 유무와 무관하게 항상 적용된다(아래 "결정: 검증 순서").
- `SchemasFor<B>`가 경로와 입력/출력 타입을 계약에서 그대로 물려받으므로, 경로 오타와 스키마 출력 타입이 계약과 다른 경우는 컴파일 에러다. 스키마는 `Schema<T>`(`parse(value: unknown): T`) 구조면 되고 zod에 의존하지 않는다. 파일을 분리하고 싶으면 `satisfies SchemasFor<AppBridge>`로 타입 검사를 유지한 채 값을 다른 파일에 둔다.

`options.errors: ErrorsFor<B>`도 같은 모양이되 RPC 경로만 값(`readonly string[]`, 허용 도메인 에러 코드 목록)을 가진다. 목록에 없는 코드는 지금처럼 안전한 오류로 바뀐다. Renderer 쪽 에러 코드 타입 추론은 하지 않는다(범위 밖).

생성 시점에 `schemas`·`errors`가 impl에 없는 경로를 참조하면(`SchemasFor<B>`/`ErrorsFor<B>` 타입 자체가 계약 `B`에서 파생하므로 일반적으로는 컴파일 에러다) 남는 경우 — 예: 타입을 우회한 옵션 객체 — 는 생성 시 `TypeError`로 거부한다.

## 결정: 검증 순서는 구조·크기 검사를 항상 먼저 적용하고, 도메인 스키마는 그 안쪽에서 선택 적용한다

요청 처리 순서: `parseBridgeValue(input)`(구조·크기, 항상 적용) → 입력 스키마(있으면; 실패 시 `INVALID_ARGUMENT`) → handler → 출력 스키마(있으면) → `parseBridgeValue` + clone(항상 적용).

"사용자 코드가 필요 없는 검사"(구조·크기 `parseBridgeValue`와 payload 한도, 세션 자원 한도, origin/sender 검사, envelope 파싱)는 스키마 유무와 무관하게 기본 유지한다 — 줄이는 대상은 사용자가 손으로 쓰는 코드량이지 라이브러리 내부 검사가 아니다. 출력 검증 실패는 `INTERNAL`이고 diagnostics에 `{ type: "validation-failed", key }`를 기록한다(ADR 0004·architecture.md의 기존 분류를 그대로 따르며, 도메인 스키마가 없는 경로에는 이 실패 유형이 애초에 없다).

## 결정: event buffer는 source 옵션으로 옮긴다

계약에는 buffer capacity·overflow 선언 자리가 없다(계약이 타입이라 값을 담을 수 없다). Main에서 source를 만들 때 옵션으로 준다: `eventSource(data$, { buffer })`. 생략하면 기본값(`capacity: 100`, `overflow: "error"`)을 쓴다. capacity 검증(양의 정수 등)은 기존 `event()` descriptor가 하던 검사를 그대로 옮긴다.

> **개정 (RD-029, `ROADMAP.md#RD-029`)**: 위 capacity 검증은 "source 생성 시점"이 아니라 `createBridgeServer` 등록 단계(registration)로 옮겼다. `overflow` 값(`"error" | "drop-oldest" | "drop-newest"`)도 같은 단계에서 검증하며, 이전에는 오타가 조용히 `drop-oldest`로 동작했다. `broadcastEvent`/`scopedEvent` helper는 이제 검증을 하지 않는 순수 생성자다 — 헬퍼를 쓰지 않고 직접 작성한 source 객체 리터럴도 registration이 같은 규칙으로 검증하므로, 헬퍼 우회로 검증을 피할 수 없다.

## 결정: `payloadLimits`는 서버 옵션이다(ADR 0004 개정)

ADR 0004는 `payloadLimits`를 "계약(`contract.payloadLimits`)과 기본값을 병합"한다고 정했다. 계약이 타입이 되어 값을 가질 수 없으므로, 한도는 `createBridgeServer(impl, { payloadLimits })`의 서버 옵션으로 옮긴다. 병합 규칙(지정한 필드만 기본값을 덮어씀)과 한도 자체(깊이·항목 수·문자열 byte·전체 byte)는 바꾸지 않는다. 강제 지점이 서버 하나라는 ADR 0004의 나머지 결정(Electron 어댑터·preload는 값 프로필만 검사)도 유지한다.

## 결정: 기존 API를 대체하고 호환 계층을 두지 않는다

`defineDomain`·`rpc`·`state`·`event`·`composeContracts`·`implementDomain`을 제거한다. 이 패키지는 npm 배포 이력이 없고 소비자는 저장소 내부(`apps/demo`, Electron fixture, README)뿐이므로 별도 호환 계층 없이 한 번에 이전한다.

## 기각한 대안

- **identity/brand 스키마 helper(`trusted<T>()`)**: 스키마 자리는 줄지 않고 descriptor 구조가 남는다.
- **스키마 인자 optional화(`rpc<I, O>()`)**: descriptor 선언 비용이 남는다.
- **계약 전역 `validate: false`**: 부분 적용이 불가능하다.
- **Main handler wrapper(`validated(schema, handler)`)**: 검증 정책이 구현 곳곳에 흩어진다.
- **문자열 키 스키마 map(`"device/send"`)**: 오타를 컴파일 단계에서 잡지 못한다.
- **Proxy로 스키마 자동 부착**: TS 타입은 런타임에 없으므로 Proxy가 스키마를 만들 정보가 없다.
- **구조·크기 검사까지 생략**: 사용자 코드 비용이 0인 검사를 선택으로 빼면 보안을 올릴 때 오히려 코드가 늘어난다.
- **전 계층(preload, Renderer) operation별 신뢰 분기**: 프로토콜·manifest·preload 변경이 필요하다.

## 이전(migration)

- `defineDomain(name, { rpc, state, event })` 선언은 계약 타입 `B`의 해당 도메인 타입 리터럴로 바꾼다.
- `composeContracts(...)`로 합치던 도메인들은 계약 타입 `B`의 최상위 키로 나열한다.
- `implementDomain(domain, handlers)`이 반환하던 구현 객체는 `impl: BridgeImpl<B>`의 해당 도메인 필드로 바꾼다.
- `createBridgeServer(contract, implementations, options)` 호출은 `createBridgeServer<B>(impl, options)`로 바꾼다. `options.payloadLimits`는 그대로 옵션이지만 이제 유일한 자리다(계약에는 더 이상 없다).
- 스키마를 쓰던 도메인은 `options.schemas`에 같은 경로로 옮기고, 허용 에러 코드는 `options.errors`로 옮긴다.
- `InferBridge<Contract>`로 만들던 Renderer 타입은 `BridgeApi<B>`로 바꾼다(`B`는 계약 타입, `Contract`가 아니다).
