# `createBridgeServer`는 생성 시 합성된 계약 전체를 기준으로 구현 등록을 이름 집합으로 재검증한다

이전까지 `implementDomain`은 도메인 하나 단위로 rpc·state·event의 누락·초과와 소스 형태를 검사했지만, `createBridgeServer`는 그 결과를 그대로 신뢰했다. 도메인 단위 조회는 `Array#find`(`rpc-dispatcher.ts`의 `findRpc`, `stream-hub.ts` 생성자)로 이루어져 계약에 없는 도메인의 구현은 조용히 무시되고, 같은 `domainName`이 두 번 등록되면 먼저 등록된 쪽만 살아남았다. 계약에 선언된 도메인에 구현이 아예 없어도 서버는 생성에 성공했고, 실패는 그 operation을 실제로 호출한 시점에 `NOT_FOUND "Unknown bridge operation."`/`"Unknown bridge stream."`로만 드러났다. `StreamHub`에 넘기는 인자도 `as readonly StreamDomainImplementation[]`로 캐스팅되어, 인자 타입(`DomainImplementation[]`, rpc만 있음)과 실제로 기대하는 형태(state·event 포함)가 컴파일 타임에 맞지 않아도 타입 검사를 통과했다.

## 결정: 생성 시 계약 전체와 대조하고, 첫 불일치에서 `TypeError`를 던진다

`createBridgeServer(contract, implementations)`는 `registerImplementations`(`packages/rx-bridge-electron/src/main/registration.ts`)를 호출해 `implementations` 배열 전체를 합성된 계약(`ComposedContract`)의 도메인 집합과 대조한다.

- 계약에 선언된 도메인에 대응하는 구현이 없으면 `Missing domain implementation '<name>'.`
- 같은 `domainName`이 두 번 이상 나오면 `Duplicate domain implementation '<name>'.`
- 계약에 없는 `domainName`이 있으면 `Unknown domain implementation '<name>'.`

이 세 검사를 통과한 각 구현은 다시 `normalizeImplementation`으로 도메인 하나 단위 검사를 받는다: 선언된 rpc·state·event 키가 각각 정확히 있어야 하고(`Missing RPC handler`/`Missing State source`/`Missing Event source`, `Undeclared RPC handler`/`Undeclared State source`/`Undeclared Event source`), rpc handler는 함수여야 하며(`RPC handler '<domain>/<key>' must be a function.`), state 소스는 `Observable`이면서 `getValue`를 가져야 하고(`State source '<domain>/<key>' must have a current value.`), event 소스는 `Observable`이거나 `{ mode: "broadcast", source: Observable }`/`{ mode: "scoped", factory: function }` 형태여야 한다(`Event source '<domain>/<key>' must be an Observable or source adapter.`). 검사는 카테고리 순서(rpc → state → event)와 카테고리 내부 순서(선언 안 된 항목 → 형태 오류 → 누락 항목)를 고정하고, 어느 조건이든 어긋나면 즉시 `TypeError`를 던진다 — 여러 문제를 모아 보고하지 않는다.

서버는 `implementDomain`이 반환한 값도 다시 검사한다. 두 가지 이유가 있다.

1. **같은 이름, 다른 정의의 도메인**: `implementDomain(domainA, handlers)`이 반환하는 값은 `domainName: "a"`라는 문자열만으로 서버와 연결된다. `domainA`가 서버에 넘긴 계약의 `"a"` 도메인과 이름은 같지만 operation 집합이 다른 별도 `DomainContract` 객체일 수 있다(테스트: `registration.test.ts`의 "throws when a same-named domain implementation declares a different operation set"). `implementDomain`은 자신에게 넘어온 `domainA` 기준으로만 검사했으므로 이 불일치를 알 도리가 없다.
2. **직접 만든 구현 객체**: `DomainImplementation`은 공개 타입이라 `implementDomain`을 거치지 않고 `{ domainName, rpc, state, event }` 형태의 객체를 직접 만들어 넘길 수 있다. 이 경로는 타입 검사(excess property check 등)의 보호를 받지 않으므로 런타임 검사가 유일한 방어선이다.

따라서 검증 로직을 `normalizeImplementation`(도메인 하나) / `registerImplementations`(계약 전체)로 분리해 `implementDomain`과 `createBridgeServer` 양쪽이 같은 함수를 공유한다. `implementDomain`이 이미 통과시킨 값을 서버가 또 검사하는 것은 중복이 아니라, "이 값이 어떻게 만들어졌는지 신뢰하지 않는다"는 서버 쪽 불변식이다.

## 결정: 일치 기준은 이름 집합이다 — descriptor 참조 동일성은 비교하지 않는다

도메인 일치는 `domainName` 문자열, operation 일치는 rpc·state·event 각 카테고리의 키 문자열 집합으로만 판정한다. `implementDomain(domain, handlers)`에 넘긴 `domain`이 서버에 넘긴 계약이 들고 있는 `DomainContract` 객체와 같은 참조인지는 확인하지 않는다.

참조 동일성을 요구하지 않는 이유는 두 가지다.

- **구조 변경 비용**: `composeContracts`(`src/contract/compose-contracts.ts`)는 도메인 객체를 새로 만들어 freeze하지만 descriptor(각 rpc·state·event 정의)는 원본과 같은 참조를 복사한다. 참조 동일성을 기준으로 삼으려면 이 복사 규칙 전체를 등록 검증의 전제 조건으로 고정해야 하고, 계약 조합 방식이 바뀔 때마다 등록 검증도 함께 깨진다.
- **남는 사고 범위가 좁다**: 같은 이름이지만 operation 키 집합이 다른 도메인으로 `implementDomain`한 결과는 런타임 검사(`registerImplementations`)가 잡는다. 잡지 못하는 경우는 이름과 키 집합이 모두 같고 스키마만 다른 별도 `DomainContract`로 구현한 경우뿐이다. `DomainImplementation<Name>`은 handler·소스 타입을 지우므로 이 경우는 타입 검사도 통과한다. 이때도 서버는 자신이 받은 계약의 descriptor로 입력·출력을 검증하므로(`findRpc`·`StreamHub`는 `contract`의 descriptor를 쓴다) 스키마에 맞지 않는 값이 handler나 Renderer로 넘어가지는 않는다. handler가 기대한 입력 타입과 실제 입력이 다를 수 있다는 위험은 수용한다.

## 결정: 검증을 통과한 정규화 사본만 등록한다

`normalizeImplementation`은 원본 `candidate` 객체를 그대로 등록하지 않고, 각 카테고리를 새 `Object.create(null)` 레코드에 키 하나씩 복사한 뒤 `Object.freeze`한 새 `DomainImplementation`을 반환한다. `registerImplementations`가 만드는 `Map<string, DomainImplementation>`은 이 정규화된 사본만 담는다. 따라서 `createBridgeServer` 호출 이후 원본 구현 객체(또는 그 안의 `rpc`/`state`/`event` 레코드)를 변경해도 이미 등록된 서버 동작에는 영향이 없다(테스트: `registration.test.ts`의 "ignores later mutation of the original implementation object").

## 결정: 타입 쪽 — handler·소스 추론, 키 필수·초과 금지, 도메인 집합은 런타임만 검사

`implementDomain<Name, Definitions>(domain: DomainContract<Name, Definitions>, handlers: DomainHandlers<Definitions>)`(`src/main/implement-domain.ts`)는 `handlers`의 형태를 `domain`의 `DomainDefinitions`에서 추론한다.

- rpc handler는 `(input: I, context: BridgeContext) => O | Promise<O>`다. `I`/`O`는 `RpcDescriptor<I, O, ...>`에서 추론한다. 반환 타입을 `O`(출력 스키마의 출력 타입) 단독이 아니라 `O | Promise<O>`로 둔 이유는 동기 handler와 비동기 handler를 같은 시그니처로 받기 위해서다 — `Schema` 자체는 바꾸지 않는다.
- state 소스는 `CurrentValueSource<T>`, event 소스는 `EventSource<T>`이고 `T`는 각각 `StateDescriptor<T>`/`EventDescriptor<T>`에서 추론한다.
- 도메인 정의에 선언된 rpc·state·event 키는 `CategoryHandlers`(`implement-domain.ts`)가 Mapped 타입으로 모두 필수로 만든다. 초과 키는 별도 코드로 막지 않고 TypeScript의 객체 리터럴 excess property check에 맡긴다. 도메인에 없는 카테고리는 `?: never`로 필드 자체를 막고, 카테고리는 있지만 키가 없으면(`declaredRpc`가 빈 객체) 필드를 값이 `never`인 index signature(`{ readonly [key: string]: never }`)로 제한해 빈 객체만 허용한다(`Record<never, never>`는 `{}`라서 excess property check가 적용되지 않는다).
- `createBridgeServer<Contract>(contract, implementations: readonly DomainImplementation<keyof Contract["domains"] & string>[], ...)`(`create-bridge-server.ts`)는 각 구현의 이름 제네릭을 계약의 도메인 이름 합집합으로 제약한다. 이 타입은 원소 하나하나가 알려진 도메인 이름인지만 보고, 배열 전체가 계약의 모든 도메인을 정확히 한 번씩 덮는지는 보지 않는다 — TypeScript 타입 시스템으로 "배열 원소의 이름 집합이 정확히 어떤 유니온과 같다"를 표현할 수 없기 때문이다. 누락·중복은 위에서 설명한 런타임 검사(`Missing domain implementation`/`Duplicate domain implementation`)에서만 잡는다.

## 결정: `DomainImplementation`을 통합하고 `StreamDomainImplementation`을 제거한다

공개 `DomainImplementation<Name extends string = string>`(`src/main/types.ts`)은 이제 `domainName`·`rpc`·`state`·`event` 네 필드를 모두 가진 단일 타입이다. 이전에 `implement-domain.ts`가 별도로 export하던 `StreamDomainImplementation extends DomainImplementation`(state·event 추가분)는 제거했다. `createBridgeServer`는 `DomainImplementation[]`를 그대로 받고, `StreamHub`에 넘길 때 쓰던 `as readonly StreamDomainImplementation[]` 캐스팅도 제거했다 — 인자 타입과 `StreamHub`가 기대하는 형태가 이제 같은 타입이라 캐스팅이 필요 없다.

## 이전(migration)

- `implementDomain`이 반환한 값을 만든 뒤 handler 안에서 `input as ...`으로 좁히던 코드는 제거한다. `input`은 이제 descriptor의 입력 타입으로 추론된다.
- `StreamDomainImplementation`을 import하거나 타입 표기에 쓰던 코드는 `DomainImplementation`으로 바꾼다. state·event가 없는 도메인도 이제 같은 타입을 쓴다.
- 계약에는 선언되어 있지만 `createBridgeServer` 호출 시 구현을 넘기지 않던 도메인이 있다면, 이전에는 서버 생성이 성공하고 해당 operation을 호출한 시점에야 `NOT_FOUND`로 실패했다. 이제는 서버 생성 자체가 `TypeError("Missing domain implementation '<name>'.")`로 실패한다. 테스트 fixture나 데모 조합에서 의도적으로 일부 도메인을 비워 두었다면 지금 시점에 걸린다.
- 출력 스키마에 `.transform`처럼 입력·출력 형태가 다를 수 있는 스키마를 쓰는 handler는, `implementDomain`이 요구하는 반환 타입이 스키마의 **출력** 타입(`O`)이라는 점을 확인한다. handler가 변환 전 형태를 반환하도록 캐스팅해 두었다면 이제 타입 오류로 드러난다 — 캐스팅을 지우고 변환 후 타입에 맞는 값을 반환하도록 고친다.
