# 02. Renderer API

## 1. 목적과 범위

이 문서는 다음 질문에 답한다.

- `createRendererApi<B>()`는 handshake로 받은 manifest를 어떻게 검증하고 호출 트리로 바꾸는가.
- 호출 경로는 왜 `api.<domain path>.rpc|state|event.<operation>`인가.
- 트리는 왜 Proxy가 아니라 동결 객체인가.
- 어떤 이름이 예약되고, Renderer는 Main이 이미 검증한 manifest를 왜 다시 거부하는가.
- `RendererApi<B>` 타입은 계약 타입에서 어떻게 나오는가.

다루지 않는 것:

- operation key 문법과 예약어 규칙 자체, manifest 생성: [01. 계약과 등록](01-contract.md)
- transport 해석(`globalThis.rxBridge`), handshake envelope·version 검사: [03. Transport와 배선](03-transport-and-wiring.md)
- RPC 함수 호출 뒤의 동작, `CallOptions` 의미: [05. RPC](05-rpc.md)
- `RemoteState`·Event `Observable` 내부 동작: [07. Renderer 스트림과 State](07-renderer-streams.md)
- `api.dispose()` 종료 의미: [10. 종료](10-shutdown.md)
- `handshake-failed` 진단: [11. 진단](11-diagnostics.md)

## 2. 모델

### 호출 트리

Renderer 공개 호출은 계층형이다.

```ts
await api.device.rpc.connect(); // RPC
api.device.state.connection; // RemoteState
api.device.event.data; // Observable
api.device.serial.rpc.open(); // 중첩 도메인
```

manifest의 operation key `category:domain/op`는 트리 경로 `[...domain, category, op]`에 놓인다. 도메인 노드는 카테고리 노드(`rpc`·`state`·`event`)와 하위 도메인 노드를 함께 가질 수 있다.

| 트리 요소      | 값                                                                     | 생성 위치               |
| -------------- | ---------------------------------------------------------------------- | ----------------------- |
| 내부 노드      | `Object.create(null)` 객체, 동결                                       | `buildApiNode`          |
| RPC leaf       | `(input = undefined, options?) => rpcClient.call(key, input, options)` | `buildApiNode`          |
| State leaf     | `RemoteState` (`createRemoteState`)                                    | `local-generation` 모듈 |
| Event leaf     | `Observable` (`createRemoteEvent`)                                     | `local-generation` 모듈 |
| 루트 `dispose` | `lifetime.dispose()`를 부르는 함수. `Symbol.dispose`와 같은 참조       | `createRendererApi`     |

모든 경로 속성은 `Object.defineProperty(node, segment, { value, enumerable: true })`로 만든다. 결과 descriptor는 `writable: false`, `enumerable: true`, `configurable: false`다. 루트 `dispose`와 `Symbol.dispose`는 non-enumerable이다.

### 소유 모듈

| 개념                              | 소유                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| handshake 파싱·manifest 검증·트리 | `createRendererApi`(`create-renderer-api.ts`의 `parseHandshake`·`addManifestPath`·`buildApiNode`) |
| operation key 판정                | `src/protocol/operation-key.ts`의 `parseWireKey`·`OperationPathTrie`                              |
| RPC 호출                          | `RpcClient`                                                                                       |
| State·Event 구독                  | `StreamMultiplexer`, `LocalGeneration`                                                            |
| 종료 판정                         | `ApiLifetime`                                                                                     |

### 타입

```ts
type RendererApi<B> = AddCallOptions<BridgeApi<B>> &
  Disposable & { readonly dispose: () => void };

interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
```

`AddCallOptions`는 `BridgeApi<B>`를 재귀로 변환한다.

| `BridgeApi<B>`의 값               | `RendererApi<B>`의 값                                      |
| --------------------------------- | ---------------------------------------------------------- |
| `() => Promise<O>`                | `(input?: undefined, options?: CallOptions) => Promise<O>` |
| `(input: I) => Promise<O>`        | `(input: I, options?: CallOptions) => Promise<O>`          |
| `Observable<T>`, `RemoteState<T>` | 그대로                                                     |
| 객체                              | 각 키에 재귀                                               |

`CallOptions`는 입력값과 분리된 두 번째 인자다. RPC 입력은 항상 직렬화 가능한 값 하나다. 타입은 계약 `B`에서 정적으로 나오고 manifest와 무관하다.

## 3. 불변식

1. `createRendererApi`는 handshake가 끝나고 manifest 전체가 검증된 뒤에만 API를 반환한다. 검증 실패 시 `RpcClient`·`StreamMultiplexer`·`ApiLifetime`을 만들지 않는다.
2. 트리는 manifest에 있는 경로만 가진다. 없는 경로와 `Object.prototype` 멤버(`toString`, `hasOwnProperty`)는 속성이 없어 `undefined`다.
3. 도메인에 없는 카테고리는 노출하지 않는다. `api.hardware.event`는 manifest에 `event:hardware/...`가 없으면 `undefined`다.
4. 모든 노드는 null prototype이고 동결된다. 대입·삭제·속성 추가는 strict mode에서 `TypeError`로 실패하고 경로는 바뀌지 않는다.
5. 같은 경로는 항상 같은 참조다. leaf는 트리 생성 시 한 번 만든다.
6. leaf 생성에는 부작용이 없다. 원격 구독은 사용자가 `subscribe`할 때 시작된다.
7. 트리는 thenable이 아니다. `then`은 operation key 예약어라 manifest에 올 수 없다. `await api`는 `api` 자신이다.
8. 루트 `dispose`와 `Symbol.dispose`는 같은 함수다. 둘 다 non-enumerable이라 `Object.keys(api)`는 도메인만 나열한다. `Symbol.dispose in api`는 `true`다.
9. 하위 노드에는 `dispose` 예약이 없다. `api.hardware.rpc.dispose`는 일반 operation이고 `api.dispose`와 다른 함수다.
10. Renderer는 Main이 만든 manifest를 신뢰하지 않는다. Main 등록과 같은 operation key 코어로 handshake 시점에 모든 entry를 다시 검증한다.

## 4. 흐름

### `createRendererApi<B>(options?)`

1. transport를 해석한다. `options.transport`가 없으면 `globalThis.rxBridge`를 읽고, transport 모양이 아니면 `TypeError`를 던진다. 배선 오류라 진단을 기록하지 않는다. [03. Transport와 배선](03-transport-and-wiring.md)
2. `transport.connect()`를 기다린다. throw나 reject는 `RemoteError("INTERNAL", "Bridge handshake failed.")`가 된다. 원래 오류 내용은 버린다.
3. `parseHandshakeResponse`로 응답을 파싱한다. `VERSION_MISMATCH`면 `"Unsupported bridge handshake."`, 그 외 실패는 `"Malformed bridge handshake."`이고 둘 다 code `INTERNAL`이다. manifest는 정확히 `rpc`·`state`·`event` 키를 갖고 각각 문자열 배열이어야 한다.
4. manifest entry를 `rpc` → `state` → `event` 배열 순서, 배열 안에서는 선언 순서로 검증하고 트리에 넣는다. 첫 실패에서 `RemoteError("INTERNAL")`를 던진다.
5. `ApiLifetime`, `RpcClient`, `StreamMultiplexer`를 만든다. `RpcClient`·`StreamMultiplexer`는 handshake의 `protocolVersion`·`clientId`를 공유한다.
6. `buildApiNode`로 manifest 트리를 재귀 변환한다. 하위 노드는 만든 즉시 동결한다.
7. 루트에 `dispose`와 `Symbol.dispose`를 non-enumerable로 정의하고 루트를 동결해 반환한다.

2~4의 실패는 reject 직전에 진단 sink에 정확히 한 번 기록한다. [11. 진단](11-diagnostics.md)

### manifest entry 하나의 검증(`addManifestPath`)

1. `parseWireKey(key)`: category prefix, 도메인 segment, operation 이름 규칙. 실패하면 verdict reason별 메시지로 거부한다.
2. key의 category와 담긴 배열의 category가 같은지 확인한다. 다르면 `"Manifest entry has an unsupported category."`로 거부한다. Main은 이 불일치를 만들지 않으므로 Renderer만 하는 검사다.
3. 카테고리를 뺀 경로 `[...domain, op]`를 세 카테고리 공용 `OperationPathTrie`에 넣는다. leaf/namespace 충돌이나 중복이면 거부한다.
4. 트리 경로 `[...domain, category, op]`에 leaf를 삽입한다.

4는 충돌 검사를 하지 않는다. 3이 카테고리를 뺀 경로의 충돌을 이미 거부했고, 끼워 넣는 카테고리 segment는 도메인 segment로 올 수 없는 예약어라 새 충돌을 만들지 않는다.

거부 메시지:

| verdict                             | 메시지                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| `empty-segment`                     | `Manifest entry '<key>' cannot contain an empty segment.` |
| `dotted-segment`                    | `Manifest entry '<key>' cannot contain dotted segments.`  |
| `reserved-segment`                  | `Manifest entry '<key>' contains reserved segment '<s>'.` |
| `nested-operation`                  | `Manifest entry '<key>' cannot be a nested path.`         |
| `unknown-category`, category 불일치 | `Manifest entry has an unsupported category.`             |
| `leaf-namespace-collision`          | `Leaf/namespace collision at '<path>'.`                   |
| `duplicate-or-collision`            | `Duplicate path or leaf/namespace collision at '<path>'.` |

문구는 Main `TypeError`와 같은 표현을 쓰지만 계약이 아니다. 계약은 code `INTERNAL`이다.

## 5. 설계 이유와 기각한 대안

### 계층형 경로

계층형은 경로 자체가 종류를 말한다. 평면 경로에서는 호출부 텍스트와 자동 완성 목록에 RPC·State·Event가 섞여 종류를 읽으려면 타입을 봐야 했다. 계층형은 계약 타입 모양(`{ rpc, state, event }`)과도 같다. 계약 선언, wire key, handshake 형식은 바꾸지 않았다([ADR 0007](../adr/0007-hierarchical-renderer-api.md)).

계층형은 manifest key에서 도메인과 operation의 경계를 알아야 한다. operation 이름을 단일 segment로 제한해 key의 마지막 segment가 항상 operation이 되게 했다. `rpc`·`state`·`event`를 도메인 segment로 예약한 것도 계층형의 비용이다. [01. 계약과 등록](01-contract.md)

### 동결 객체 트리

Proxy 트리는 세 가지 관측 문제가 있었다([ADR 0021](../adr/0021-renderer-frozen-api-tree.md)).

- DevTools·`console.log(api)`가 빈 target(`Proxy {}`)만 보여 줬다.
- `has` trap이 문자열 `dispose`만 확인해 `Symbol.dispose in api`가 `false`였다.
- `getOwnPropertyDescriptor` trap이 `value: undefined`인 descriptor를 돌려줬다.

동결 객체 트리는 셋을 구조적으로 없앤다. 속성이 실제 data property라 DevTools, `in`, descriptor가 별도 보정 없이 맞다. 쓰기 거부는 Proxy의 `set`/`deleteProperty`/`defineProperty`가 `false`를 돌려주던 것과 결과가 같다.

### Main과 Renderer의 독립 거부

Renderer는 Main 검증에 기대지 않는다. Main이 만든 값을 그대로 믿지 않는다는 신뢰 경계 원칙이다. 규칙을 어긴 manifest가 와도 해당 경로가 트리에 들어오지 않는다. 예를 들어 `then` 경로가 들어오면 트리가 thenable이 되어 `await api`가 깨진다.

규칙 코드는 공유한다. 두 구현이 조용히 어긋나는 위험이 N-version 독립성의 이득보다 크다. 공유하는 것은 코드이고 신뢰는 공유하지 않는다.

### 기각한 대안

- 평면 경로 `api.<domain path>.<operation>`([ADR 0005](../adr/0005-renderer-api-shape.md), 대체됨): 종류 간 이름 충돌은 없지만 호출부와 자동 완성에서 종류가 드러나지 않는다.
- handshake에 도메인·operation 경계를 따로 싣기: 형식이 바뀐다. operation을 단일 segment로 제한하면 key만으로 경계가 정해진다.
- Proxy 유지와 trap 보정: `ownKeys`·`getOwnPropertyDescriptor`·`has`를 계속 손으로 맞춰야 하고 DevTools 표시는 고칠 수 없다.
- lazy getter 트리: leaf 생성이 부작용 없는 객체 생성뿐이라 lazy로 아끼는 비용이 없다. getter는 DevTools에서 `(...)`로 보여 data property보다 덜 드러난다.
- 스트림 이름 `$` 접미사 자동 부착: `RemoteState`는 `.snapshot`을 가진 확장 `Observable`이라 기준이 모호하다. 계약 키·manifest 키와 노출 이름이 달라진다. 계층의 `state`·`event`가 종류를 이미 드러낸다.
- 평면 형태 호환 별칭: npm 배포 이력이 없어 보존할 외부 소비자가 없다.

## 6. 한계

- Renderer는 manifest가 타입 `B`와 일치하는지 검증하지 않는다. Main이 다른 계약으로 만들어졌으면 타입에는 있는 경로가 런타임에 `undefined`이고, 호출 시점에 일반 JS `TypeError`로 드러난다.
- 반대로 manifest에만 있는 경로(변수를 거친 impl의 초과 operation 등)는 런타임 트리에 있지만 `RendererApi<B>` 타입에는 없다.
- 계약에 빈 카테고리(`{ a: { rpc: Record<string, never> } }`)가 있으면 `BridgeApi<B>` 타입에는 `rpc` 키가 있지만 manifest에 entry가 없어 런타임 `api.a`는 `undefined`다.
- 계약 타입은 도메인 이름 `dispose`를 막지 않는다. 그런 계약은 컴파일되고 Main 생성 시점에 거부된다.
- manifest는 handshake 한 번으로 고정된다. API 인스턴스가 살아 있는 동안 경로가 늘거나 줄지 않는다.
- 거부 메시지 문구는 계약이 아니다. 앱은 code `INTERNAL`만 판정해야 한다.

## 7. 관련 문서

- ADR: [0007 계층형 Renderer API](../adr/0007-hierarchical-renderer-api.md), [0021 동결 객체 트리](../adr/0021-renderer-frozen-api-tree.md), [0005 루트 dispose와 평면안(대체됨)](../adr/0005-renderer-api-shape.md), [0013 배선 기본값](../adr/0013-wiring-defaults.md), [0006 종료 계약](../adr/0006-shutdown-contract.md)
- 설계 문서: [01. 계약과 등록](01-contract.md), [03. Transport와 배선](03-transport-and-wiring.md), [05. RPC](05-rpc.md), [07. Renderer 스트림과 State](07-renderer-streams.md), [10. 종료](10-shutdown.md), [11. 진단](11-diagnostics.md)
