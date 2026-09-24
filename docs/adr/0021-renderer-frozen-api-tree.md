# Renderer API를 Proxy 대신 동결 객체 트리로 만든다

- 관련: ROADMAP.md#RD-027

## 상황

`createRendererApi()`는 handshake manifest 트리를 감싼 `Proxy`를 반환했다(`create-renderer-api.ts`의 `createProxy`). trap은 manifest에 있는 경로만 노출하고 leaf를 처음 접근할 때 만들어 캐시했다. 호출 형태와 타입 추론은 계약 타입 `B`에서 정적으로 나오므로 요구사항 초안 55절("동적인 `Proxy`에 지나치게 의존하지 않는다", IDE 자동 완성·타입 추론·디버깅 가능성·명확한 runtime failure)의 타입 쪽은 이미 충족했다. 런타임 쪽에는 Proxy 때문에 생긴 관측 문제가 셋 있었다:

- DevTools·`console.log(api)`가 빈 target(`Proxy {}`)만 보여 준다. 어떤 경로가 노출됐는지 보려면 `Object.keys`를 직접 불러야 한다.
- `Symbol.dispose in api`가 `false`다. `has` trap이 문자열 `dispose`만 확인했다. `using`은 `get`을 쓰므로 동작했지만 `in` 검사는 틀렸다.
- `Object.getOwnPropertyDescriptor(api.domain.rpc, "op")`가 `value: undefined`인 descriptor를 돌려준다. descriptor trap이 `value`를 채우지 않았다.

출처: `.scratch/renderer-proxy-frozen-tree`.

## 결정

1. `createRendererApi()`는 `Object.create(null)` 노드를 manifest를 따라 재귀로 만들고 `Object.freeze`한 일반 객체 트리를 반환한다.
2. leaf(RPC 함수, `RemoteState`, Event `Observable`)는 트리를 만들 때 즉시 생성해 enumerable data property로 둔다. 생성에는 부작용이 없다 — `LocalGeneration` 생성자는 필드만 대입하고, 원격 구독은 사용자가 `subscribe`할 때 시작된다. 같은 경로는 항상 같은 참조다.
3. 루트 `dispose`와 `Symbol.dispose`는 같은 함수를 담은 non-enumerable data property다. `Object.keys(api)`는 지금처럼 도메인만 나열한다.
4. manifest에 없는 경로와 `Object.prototype` 멤버는 속성이 없어 `undefined`다. `then`은 operation key 예약어라 manifest에 올 수 없으므로 트리는 thenable이 아니다 — `await api`는 api 자신이다.
5. 대입·삭제·속성 추가는 동결로 실패한다(strict mode `TypeError`). Proxy의 `set`/`deleteProperty`/`defineProperty`가 `false`를 돌려주던 것과 같은 결과다.

**기각한 대안**:

- Proxy 유지: 위 관측 문제 셋을 trap 보정으로 고칠 수 있지만, `ownKeys`·`getOwnPropertyDescriptor`·`has`를 계속 손으로 맞춰야 하고 DevTools 표시는 고칠 수 없다.
- lazy getter 트리: 처음 접근할 때 leaf를 만드는 Proxy 동작을 유지하는 안. leaf 생성이 부작용 없는 객체 생성뿐이라 lazy로 아끼는 비용이 없고, getter는 DevTools에서 `(...)`로 보여 data property보다 덜 드러난다.

## 보존

- 공개 호출 형태 `api.<domain path>.rpc|state|event.<operation>`, `RendererApi<B>` 타입, manifest 판정 규칙([ADR 0007](0007-hierarchical-renderer-api.md)), wire 형식.
- 없는 경로 `undefined`, thenable 아님, 쓰기 거부, 루트 `dispose` 예약과 `api.dispose === api[Symbol.dispose]`([ADR 0006](0006-shutdown-contract.md)).

## 이전(migration)

외부 사용 이력이 없다(버전 `0.0.0`, npm 배포 이력 없음). README "호환성 변경" 절에 항목을 추가하지 않는다. 관측이 바뀌는 것은 `Object.isFrozen(api)`(`true`), `Symbol.dispose in api`(`true`), descriptor의 `value`·`writable: false`·`configurable: false`다.
