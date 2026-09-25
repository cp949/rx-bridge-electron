# 01. 계약과 등록

## 1. 목적과 범위

이 문서는 다음 질문에 답한다.

- 계약은 무엇이고, Main 구현·Renderer API·스키마 map 타입은 계약에서 어떻게 파생되는가.
- `createBridgeServer`는 impl 객체에서 무엇을 검사하고, 등록 table과 manifest를 어떻게 만드는가.
- operation key 문법과 예약어는 무엇이고, 누가 소유하는가.
- `authorize`가 받는 `BridgeOperation`은 어떤 모양인가.
- Event source는 등록 시점에 어떻게 정규화되는가.

다루지 않는 것:

- Renderer가 manifest를 해석해 호출 트리를 만드는 과정: [02. Renderer API](02-renderer-api.md)
- `authorize` 호출 순서와 RPC 처리 순서: [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md)
- 스키마 적용 순서, 출력 경계, 도메인 에러 직렬화, `authorize` 예외 분류, `payloadLimits`: [08. Payload와 오류 모델](08-payload-and-errors.md)
- Event buffer의 실행 중 동작(overflow, ack): [06. Main 스트림 전달](06-stream-delivery.md)

## 2. 모델

### 계약은 타입이다

계약은 런타임 값이 아니라 TS 타입 `B`다. 계약은 도메인들의 중첩 객체 타입이다.

```ts
type AppBridge = {
  device: {
    rpc: {
      connect(): Connection;
      send(input: { command: string }): SendResult;
    };
    state: { connection: Connection };
    event: { data: SerialLine };
    serial: { rpc: { open(): Connection } };
  };
};
```

- 노드가 `rpc`·`state`·`event` 중 하나라도 키로 가지면 그 노드는 도메인이다. 그 외 키는 하위 namespace로 재귀한다. 한 노드가 카테고리와 하위 도메인을 동시에 가질 수 있다(위 `device`와 `device.serial`).
- RPC는 인자 0개 또는 1개인 메서드 시그니처다. 인자가 둘 이상이면 파생 타입이 `never`가 된다. 와이어가 단일 `input`만 싣기 때문이다.
- State는 값 타입, Event는 발생 값 타입이다.
- `/contract` 진입점은 타입만 export한다. 런타임 계약 값, 계약 조합 함수, 등록 함수는 없다.

### 파생 타입

| 타입            | 소비자                    | 모양                                                                                                                  |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BridgeImpl<B>` | Main `createBridgeServer` | RPC → `(input, context: BridgeContext) => O \| Promise<O>`, State → `CurrentValueSource<T>`, Event → `EventSource<T>` |
| `BridgeApi<B>`  | Renderer 타입의 기반      | RPC → `() => Promise<O>` 또는 `(input: I) => Promise<O>`, State → `RemoteState<T>`, Event → `Observable<T>`           |
| `SchemasFor<B>` | `options.schemas`         | 모든 필드 optional. RPC → `{ input?: Schema<I>; output?: Schema<O> }`, State·Event → `Schema<T>`                      |
| `ErrorsFor<B>`  | `options.errors`          | 모든 필드 optional. RPC operation에만 `readonly string[]`                                                             |

- 네 타입은 같은 재귀 규칙(카테고리 키는 대응 필드, 나머지 키는 재귀)을 따른다. 노드에 없는 카테고리는 필드 자체가 생기지 않는다.
- 입력 없는 RPC의 handler 타입은 `(input: undefined, context)`다. dispatcher가 항상 2-인자로 호출하기 때문이다. 입력 없는 RPC의 `SchemasFor` 항목에는 `input` 필드가 없다.
- 값 타입이 `BridgeValue`가 아니면 해당 leaf가 `never`가 된다(`BridgeValueOrNever`). 오류는 계약 선언 시점이 아니라 그 leaf에 handler·source·스키마를 대입하는 시점에 난다. 타입 매개변수 제약(`T extends BridgeValue`)을 쓰면 `B`가 구체화되기 전 라이브러리 코드에서 바로 컴파일 오류가 나기 때문이다.
- Renderer 소비자가 받는 타입은 `RendererApi<B>`다. `BridgeApi<B>`에 `CallOptions`와 루트 `dispose()`를 더한다. [02. Renderer API](02-renderer-api.md)가 소유한다.
- 파생 타입의 상세 규격은 `src/contract/bridge-types.ts` 선언과 타입 test(`test/contract/bridge-types.test.ts`의 `expectTypeOf`·`@ts-expect-error`)다.

### 구현 측 타입

`BridgeImpl<B>`가 참조하는 `BridgeContext`·`SenderIdentity`·`CurrentValueSource`·`EventSource`와 구성 타입은 `contract/impl-types.ts`가 소유한다. `src/contract/`는 패키지 내부 모듈 중 `src/protocol/`에만 의존하고 `src/main/*`을 타입으로도 import하지 않는다. eslint `@typescript-eslint/no-restricted-imports`가 강제한다. 이 타입들은 `/main`에서 type export하고 `/contract`에서는 export하지 않는다. 앱은 buffer 옵션 객체나 source 반환 타입을 `BridgeImpl<B>` indexed access 없이 선언한다.

`EventSource<T>`는 세 형태 중 하나다.

| 형태                                     | 의미                                        |
| ---------------------------------------- | ------------------------------------------- |
| `Observable<T>`                          | broadcast, 기본 buffer                      |
| `{ mode: "broadcast", source, buffer? }` | key당 upstream 하나를 구독자가 공유         |
| `{ mode: "scoped", factory, buffer? }`   | 구독마다 `factory(context)`로 upstream 생성 |

`broadcastEvent(source, { buffer })`·`scopedEvent(factory, { buffer })`는 검증하지 않는 순수 생성자다. 동결 객체만 만든다. `currentValueSource(source)`는 생성 시 `Observable`이면서 `getValue`가 함수인지 검사하고, 아니면 `TypeError("State source must have a synchronous getValue() and Observable subscription.")`를 던진다.

### 등록 table과 manifest

| 개념               | 소유                             | 내용                                                                                      |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------- |
| 등록 table         | `buildRegistrationTableFromImpl` | category별 `Map<wire key, entry>`. entry는 handler/source, 선택 스키마, `BridgeOperation` |
| manifest           | `manifestFromTable`              | `{ rpc, state, event }`, 각 wire key 문자열 배열. 동결. 공개 타입 이름은 `PublicManifest` |
| operation key 문법 | `src/protocol/operation-key.ts`  | 생성·분해, segment·예약어 검증, 경로 충돌 trie. 비공개 모듈                               |

`RpcRequests`·`Subscriptions`는 impl 트리가 아니라 등록 table만 읽는다. entry의 `kind` 필드는 내부 이름이다.

### operation key

operation key(wire key)는 `category:domain/op` 형식이다. 예: `rpc:device/connect`, `state:device/serial/status`.

- `category`는 `rpc`·`state`·`event` 중 하나다.
- 마지막 `/` 뒤가 operation, 그 앞 전체가 도메인 경로다. operation 이름은 `/` 없는 단일 segment다.
- 도메인은 최소 한 segment다. `rpc:x`처럼 도메인이 없는 key는 빈 segment로 거부한다.

segment 규칙:

| 규칙                                              | 적용 위치                     | verdict reason     |
| ------------------------------------------------- | ----------------------------- | ------------------ |
| 빈 문자열 금지                                    | 도메인·operation 모든 segment | `empty-segment`    |
| `.` 포함 금지                                     | 도메인·operation 모든 segment | `dotted-segment`   |
| `__proto__`·`prototype`·`constructor`·`then` 금지 | 도메인·operation 모든 segment | `reserved-segment` |
| `dispose` 금지                                    | 도메인 첫 segment만           | `reserved-segment` |
| `rpc`·`state`·`event` 금지                        | 도메인 모든 segment           | `reserved-segment` |
| operation에 `/` 금지                              | operation                     | `nested-operation` |
| prefix가 `rpc`·`state`·`event`가 아님             | key 전체                      | `unknown-category` |

- 중첩 위치의 `dispose` 도메인 segment(`a/dispose`)와 operation 이름 `dispose`는 허용한다.
- `rpc`·`state`·`event`는 operation 이름으로 허용한다(`rpc:device/state`). operation은 종류 아래에 놓이므로 Renderer 경로와 겹치지 않는다.
- 규칙은 `checkSegment`(위치 무관) → `checkDomainSegments`(segment 순서대로 위치 무관 검사 → 첫 segment `dispose` → 카테고리 이름) → `checkOperationName` 순서로 적용하고 첫 실패에서 멈춘다.

경로 충돌 규칙(`OperationPathTrie`): 카테고리를 뺀 `domain/op` 경로를 세 카테고리 전체에 걸쳐 한 trie에 넣는다.

| 상황                                      | 예                             | reason                     |
| ----------------------------------------- | ------------------------------ | -------------------------- |
| 기존 leaf 아래에 경로 추가                | `rpc:a/b` 뒤 `rpc:a/b/c`       | `leaf-namespace-collision` |
| 기존 namespace 자리 또는 같은 자리에 leaf | `rpc:a/b/c` 뒤 `rpc:a/b`, 중복 | `duplicate-or-collision`   |
| 카테고리가 달라도 같은 경로               | `rpc:a/x`와 `state:a/x`        | `duplicate-or-collision`   |

코어 함수는 throw하지 않고 verdict를 반환한다. 오류 타입과 메시지 조립은 호출자 책임이다. Main은 `TypeError`, Renderer는 `RemoteError("INTERNAL")`로 번역한다.

### BridgeOperation

```ts
type OperationCategory = "rpc" | "state" | "event";

interface BridgeOperation {
  readonly key: string; // "rpc:admin/users/remove"
  readonly category: OperationCategory; // "rpc"
  readonly domain: readonly string[]; // ["admin", "users"]
  readonly operation: string; // "remove"
}

type Authorize = (
  context: BridgeContext,
  operation: BridgeOperation,
) => boolean | Promise<boolean>;
```

- 등록 시 operation마다 한 번 만들고 객체와 `domain` 배열을 `Object.freeze`한다. 요청마다 할당하지 않는다.
- 공개 계약은 "동결된 객체"까지다. 같은 operation이 같은 객체라는 동일성은 계약이 아니다. 비교는 `key`로 한다.
- `BridgeOperation`·`OperationCategory`는 `/main`에서 type export한다. `./protocol`은 `OperationCategory`를 re-export하지 않는다.
- 진단 이벤트의 `key`는 `BridgeOperation`이 아니라 wire key 문자열이다. [11. 진단](11-diagnostics.md)

## 3. 불변식

1. 계약과 구현의 일치(누락 도메인·카테고리·operation, handler 입력·반환 타입, source 값 타입)는 `B`와 `BridgeImpl<B>`가 같은 타입에서 파생한다는 사실로 컴파일 타임에 검사된다. 런타임 대조 대상인 계약 값은 없다.
2. manifest는 impl 트리의 키에서만 만든다. impl에 없는 operation은 manifest에 없고 Renderer에 노출될 방법이 없다. "빠진 구현을 던져서 잡는다"가 아니라 "빠진 구현은 노출될 방법이 없다"는 보장이다.
3. 런타임 형태 검사는 타입을 우회한 값만 상대한다. 타입 검사를 통과한 impl에서는 발동하지 않는다.
4. 등록은 원자적이다. 검사 하나라도 실패하면 `createBridgeServer`가 `TypeError`를 던지고 어떤 source도 구독하지 않는다.
5. 등록 table은 impl에서 읽은 handler·source 참조로 새로 만든다. 생성 후 원본 impl 객체나 그 안 레코드를 바꿔도 서버 동작은 바뀌지 않는다.
6. manifest는 서버당 한 번 만들고 동결한다. 모든 세션·창·role이 같은 manifest를 받는다. role별 차등은 manifest가 아니라 요청마다 호출되는 `authorize`가 한다.
7. manifest 순서는 category 안에서 도메인 이름 정렬 → 도메인 안 operation 이름 정렬이다. impl 순회 순서에 기대지 않는다. wire key 문자열 전체 정렬과 다르다(`rpc:a/op`, `rpc:a-x/op`, `rpc:a/b/op` 순).
8. operation key 문법 코드는 `src/protocol/operation-key.ts` 하나다. Main 등록과 Renderer manifest 파서가 같은 코어를 호출한다.
9. 등록된 모든 Event entry는 `broadcast` 또는 `scoped` 두 갈래 중 하나이고 검증된 동결 buffer를 가진다. 실행 중 코드는 raw `EventSource`를 판별하지 않는다.
10. `options.schemas`·`options.errors`의 모든 operation 경로는 impl에 대응 operation이 있다. 없으면 생성 시 거부한다.

## 4. 흐름

### `createBridgeServer(impl, options)` 생성

1. `resolvePayloadLimits(options.payloadLimits)`. 실패 시 `TypeError`. [08. Payload와 오류 모델](08-payload-and-errors.md)
2. `buildRegistrationTableFromImpl(impl, schemas, errors)`. 아래 순회.
3. `resolveResourceLimits(options.resourceLimits)`. [09. 세션 자원 한도](09-resource-limits.md)
4. `manifestFromTable(table)`로 manifest를 만들고 서버 모듈(`DocumentSessions`·`Subscriptions`·`RpcRequests`)을 배선한다.

잘못된 impl과 잘못된 `resourceLimits`가 함께 있으면 등록 오류가 먼저 난다.

### impl 트리 순회(`walkImplNode`)

노드마다 다음 순서로 검사하고 첫 위반에서 `TypeError`를 던진다. 여러 문제를 모아 보고하지 않는다.

1. 노드가 plain object인지 검사한다. prototype은 `Object.prototype` 또는 `null`, 키는 문자열, 속성은 enumerable data property만 허용한다. accessor·symbol key·class 인스턴스를 거부한다.
2. 카테고리를 `rpc` → `state` → `event` 순서로, 노드가 가진 것만 처리한다.
   1. 도메인 경로 전체에 `checkDomainSegments`를 적용한다. 루트 노드에 카테고리가 있으면 도메인이 비어 `empty-segment`로 거부한다.
   2. 카테고리 레코드가 plain object인지 검사한다.
   3. operation마다: `checkOperationName` → 경로 trie 추가 → `BridgeOperation` 생성·동결 → leaf 형태 검사와 entry 생성.
3. 카테고리가 아닌 키를 하위 namespace로 보고 `/`가 있으면 거부한 뒤 키 하나를 segment 하나로 `checkSegment`(위치 무관 규칙)에 넣고 재귀한다. `{ "a/b": ... }`를 허용하면 `{ a: { b: ... } }`와 wire key가 같으면서 `BridgeOperation.domain`이 `["a/b"]`로 달라지기 때문이다. 첫 segment `dispose`·카테고리 이름 규칙은 그 아래 카테고리를 만났을 때 2-1에서 적용된다. `schemas`·`errors`의 같은 경로 서브트리를 함께 내려보낸다.

순회가 끝나면 `options.schemas`, `options.errors` 순서로 옵션 트리만 따로 순회해 impl에 없는 경로를 거부한다. impl 순회는 impl에 있는 경로만 옵션에서 읽으므로 옵션에만 있는 경로(오타)는 이 단계에서만 걸린다. 옵션의 namespace 키·operation 이름에 `/`가 있으면 먼저 거부한다. `{ "a/b": { rpc: { x } } }`는 wire key가 impl `{ a: { b: { rpc: { x } } } }`와 같아 경로 조회를 통과하지만 impl 순회가 읽지 않아 조용히 무시되기 때문이다.

### leaf 형태 검사

| category | 허용 형태                                                     | 거부 메시지                                                      |
| -------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| rpc      | 함수                                                          | `RPC handler '<path>' must be a function.`                       |
| state    | `instanceof Observable`이고 `getValue`가 함수                 | `State source '<path>' must have a current value.`               |
| event    | `Observable`, `mode: "broadcast"` 객체, `mode: "scoped"` 객체 | `Event source '<path>' must be an Observable or source adapter.` |

`<path>`는 `domain/op`다. rpc leaf의 옵션은 추가로 검사한다: 스키마 항목은 객체(`Schema entry for 'rpc:<path>' must be an object.`), errors 항목은 배열(`Declared errors for 'rpc:<path>' must be an array of error codes.`)이어야 한다. errors 배열은 동결 사본으로 entry에 담는다.

### Event source 정규화(`readEventEntry`)

| 입력                         | 추가 검사               | 결과 `delivery`                                | buffer        |
| ---------------------------- | ----------------------- | ---------------------------------------------- | ------------- |
| plain `Observable`           | 없음                    | `{ mode: "broadcast", source }`                | 기본값        |
| `{ mode: "broadcast", ... }` | `source`가 `Observable` | `{ mode: "broadcast", source: source.source }` | `buffer` 검증 |
| `{ mode: "scoped", ... }`    | `factory`가 함수        | `{ mode: "scoped", factory }`                  | `buffer` 검증 |

- `buffer` 생략 시 기본값은 `capacity: 100`, `overflow: "error"`다.
- `buffer`를 주면 `capacity`는 양의 safe integer, `overflow`는 `"error"`·`"drop-oldest"`·`"drop-newest"` 중 하나여야 한다. 각 필드는 한 번만 읽어 검사하고 동결 사본을 저장한다. getter가 검사와 복사 사이에 다른 값을 돌려주지 못하게 하기 위해서다.
- 거부 메시지: `Event source '<path>' source must be an Observable.`, `Event source '<path>' factory must be a function.`, `Event source '<path>' buffer capacity must be a positive safe integer.`, `Event source '<path>' buffer overflow must be "error", "drop-oldest", or "drop-newest".`
- helper를 쓰지 않은 source 객체 리터럴도 같은 검사를 받는다. helper 우회로 검증을 피할 수 없다.
- 정규화된 두 갈래의 실행 중 공유·teardown은 `Upstreams`가 소유한다. [06. Main 스트림 전달](06-stream-delivery.md)

### 이름·충돌·옵션 거부 메시지

| 원인                      | 메시지                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 노드·카테고리 레코드 형태 | `<label> must be an object.` / `must be a plain object.` / `cannot contain symbol keys.` / `must contain enumerable data properties only.`                                                            |
| 도메인 경로 segment       | `Domain name cannot contain an empty segment.` / `cannot contain dotted segments.` / `contains reserved segment '<s>'.`                                                                               |
| namespace 키 segment      | `Domain name segment ...` (같은 접미사), `Domain name segment '<key>' cannot contain '/'.`                                                                                                            |
| operation 이름            | `<category> operation ...` (같은 접미사), `<category> operation '<name>' cannot be a nested path.`                                                                                                    |
| 경로 충돌                 | `Leaf/namespace collision at '<path>'.` / `Duplicate path or leaf/namespace collision at '<path>'.`                                                                                                   |
| 옵션 서브트리 형태        | `Schema entry must be an object.` / `Errors entry must be an object.` / `Schema entries for '<category>:<domain>' must be an object.` / `Errors entries for '<category>:<domain>' must be an object.` |
| 옵션 키의 `/`             | `options.schemas key '<key>' cannot contain '/'.` / `options.errors key ...`                                                                                                                          |
| 옵션에만 있는 경로        | `options.schemas path '<wire key>' has no matching implementation.` / `options.errors path ...`                                                                                                       |

`<label>`은 루트 `Bridge implementation`, 도메인 노드 `Domain '<d>' implementation`, 카테고리 `<category> implementations for '<d>'`다.

## 5. 설계 이유와 기각한 대안

### 계약을 타입으로 둔 이유

런타임 descriptor 계약은 README 최소 예제(RPC 1개, State 1개)에서도 계약 파일이 약 33줄이고 그중 약 20줄이 손으로 쓴 스키마였다. raw `ipcMain.handle`/`ipcRenderer.invoke`보다 코드가 많았다. 스키마도 전부 쓰거나 전부 안 쓰는 양자택일이었다. 계약을 타입으로 두면 계약 선언 비용이 타입 선언뿐이고, 스키마는 operation 단위로 선택한다([ADR 0012](../adr/0012-lightweight-type-contract.md)).

결과:

- 계약이 값을 가질 수 없다. `payloadLimits`는 서버 옵션, Event buffer는 source 옵션이다.
- 계약과 구현의 참조 불일치("같은 이름, 다른 정의의 도메인")가 성립하지 않는다. 참조할 별도 계약 객체가 없다.
- 등록 시 런타임 검사는 타입 우회 방어선으로 줄었다.

### 스키마 map을 계약과 같은 모양으로 둔 이유

`SchemasFor<B>`·`ErrorsFor<B>`는 경로와 입력·출력 타입을 계약에서 물려받는다. 경로 오타와 스키마 타입 불일치가 컴파일 오류다. 파일을 나누려면 `satisfies SchemasFor<AppBridge>`로 타입 검사를 유지한다. `Schema<T>`는 `parse(value: unknown): T` 구조면 되고 특정 라이브러리에 의존하지 않는다. 스키마 유무와 무관하게 구조·크기 검사는 항상 적용된다. [08. Payload와 오류 모델](08-payload-and-errors.md)

### operation key 문법을 한 모듈로 모은 이유

Main과 Renderer가 규칙을 각자 구현하면 두 구현이 조용히 어긋난다. 그 위험이 N-version 독립성의 이득보다 크다. 코드는 공유하고 신뢰는 공유하지 않는다. Renderer는 Main이 만든 manifest를 같은 코어로 다시 검증한다([ADR 0007](../adr/0007-hierarchical-renderer-api.md) 개정 절).

### 예약어를 둔 이유

- `rpc`·`state`·`event`(도메인 segment): 도메인 `device/rpc`가 있으면 `api.device.rpc`가 도메인 `device`의 RPC 묶음과 충돌한다.
- `dispose`(도메인 첫 segment): Renderer 루트 `api.dispose()`와 충돌한다([ADR 0005](../adr/0005-renderer-api-shape.md)).
- `__proto__`: object literal 대입 시 prototype setter로 취급된다. `prototype`·`constructor`: 함수·클래스 내장 속성과 충돌한다. `then`: thenable 검사와 충돌한다.
- operation 이름 단일 segment: `rpc:device/serial/open`이 도메인 `device`의 `serial/open`인지 도메인 `device/serial`의 `open`인지 모호해진다. handshake에 경계를 따로 싣지 않고 operation을 단일 segment로 제한했다.

### 카테고리 간 경로 충돌을 거부하는 이유

계층형 Renderer 경로에서는 `rpc:a/x`와 `state:a/x`, `rpc:a/b`와 `rpc:a/b/x`가 서로 다른 경로가 된다. 그래도 거부한다. wire key가 진단과 로그에서 혼동된다. 나중에 완화하는 것은 호환되지만 허용한 뒤 다시 막는 것은 호환되지 않는다.

### `authorize`에 구조화 객체를 넘기는 이유

wire key 문자열을 받으면 앱 코드가 `startsWith("rpc:")`처럼 문자열을 자른다. 형식이 바뀌어도 타입이 잡지 못한다. `authorize` 호출 시점에 Main은 이미 등록 entry를 가지므로 분해 비용이 없다. `domain`을 배열로 둔 이유는 `domain[0] === "admin"` 같은 판정에 다시 문자열 파싱이 필요 없게 하기 위해서다([ADR 0018](../adr/0018-authorize-structured-operation.md)).

### 기각한 대안

- descriptor 기반 계약(`defineDomain`·`rpc`·`state`·`event`·`composeContracts`·`implementDomain`): 계약 선언 비용이 크고 스키마가 양자택일이다. 호환 계층을 두지 않는다([ADR 0012](../adr/0012-lightweight-type-contract.md)).
- 생성 시 계약 전체와 구현 배열을 이름 집합으로 재검증([ADR 0008](../adr/0008-contract-registration-match.md), 대체됨): 대조할 런타임 계약이 사라져 전제가 성립하지 않는다. 누락·초과는 컴파일 타임에, 노출은 impl 키로 결정된다.
- identity/brand 스키마 helper(`trusted<T>()`): 스키마 자리가 줄지 않고 descriptor 구조가 남는다.
- 스키마 인자 optional화(`rpc<I, O>()`): descriptor 선언 비용이 남는다.
- 계약 전역 `validate: false`: operation 단위 부분 적용이 불가능하다.
- Main handler wrapper(`validated(schema, handler)`): 검증 정책이 구현 곳곳에 흩어진다.
- 문자열 키 스키마 map(`"device/send"`): 경로 오타를 컴파일 단계에서 잡지 못한다.
- Proxy로 스키마 자동 부착: TS 타입은 런타임에 없어 Proxy가 스키마를 만들 정보가 없다.
- Main·Renderer operation key 규칙 독립 구현: 조용한 불일치 위험이 독립성 이득보다 크다.
- `parseWireKey` 공개 export로 `authorize` 인자 분해를 사용자에게 맡김: `authorize`는 등록된 key만 받아 verdict 실패 분기가 쓰이지 않는데 그 분기가 공개 계약이 된다.
- wire key 형식만 문서화: 문자열 파싱이 사용자 코드에 남고 타입 보장이 없다.
- `authorize` 세 번째 인자로 `BridgeOperation` 추가: 같은 정보가 두 번 들어와 어느 쪽을 써야 하는지 모호하다.

## 6. 한계

- 초과 키의 컴파일 오류는 TypeScript excess property check에 의존한다. 이 검사는 fresh object literal에만 적용된다. 변수를 거쳐 대입한 impl의 초과 operation은 타입 검사를 통과하고, 런타임 등록되어 manifest에 노출된다. Renderer 타입 `RendererApi<B>`에는 나타나지 않는다.
- 계약 타입은 예약어를 거부하지 않는다. `{ dispose: {...} }`, `{ then: {...} }`, operation 이름 `a.b` 같은 계약은 컴파일되고 `createBridgeServer` 생성 시 `TypeError`로 거부된다.
- 스키마 값의 모양(`parse` 함수 보유)은 등록 시 검사하지 않는다. rpc 스키마 항목이 객체인지만 본다. State·Event 스키마 항목은 형태를 보지 않는다.
- `options.errors`에서 state·event 경로 항목은 해당 경로가 impl에 있으면 거부되지 않고 무시된다. errors 배열 원소가 문자열인지도 검사하지 않는다. 둘 다 타입을 우회한 경우에만 생긴다.
- 빈 namespace(`{ a: {} }`)와 빈 카테고리(`{ a: { rpc: {} } }`)는 허용되고 manifest에 아무것도 남기지 않는다.
- `Observable` 판정은 `instanceof Observable`이다. 앱이 패키지와 다른 rxjs 인스턴스의 `Observable`을 넘기면 State·Event 형태 검사에서 거부된다.
- Renderer 쪽 도메인 에러 코드 타입 추론은 하지 않는다. `ErrorsFor<B>`는 Main 옵션 타입일 뿐이다.

## 7. 관련 문서

- ADR: [0012 계약은 TS 타입](../adr/0012-lightweight-type-contract.md), [0007 계층형 Renderer API와 key 문법 단일 소유](../adr/0007-hierarchical-renderer-api.md), [0005 루트 dispose 예약](../adr/0005-renderer-api-shape.md), [0018 BridgeOperation](../adr/0018-authorize-structured-operation.md), [0008 등록 재검증(대체됨)](../adr/0008-contract-registration-match.md)
- 설계 문서: [02. Renderer API](02-renderer-api.md), [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md), [08. Payload와 오류 모델](08-payload-and-errors.md), [11. 진단](11-diagnostics.md)
- 용어: [CONTEXT.md](../../CONTEXT.md)의 계약, operation key, `BridgeApi<B>`/`BridgeImpl<B>`, `SchemasFor<B>`/`ErrorsFor<B>`, Event 전달 방식
