// RD-017: operation key(wire key `category:domain/op`) 문법의 accept/reject
// 판정을 고정하는 공유 case table이다. DELTA-01(동등성 고정)에서 Main·Renderer
// seam 양쪽에 이 table을 돌려 "두 구현이 같은 wire key 집합에 같은 판정을
// 낸다"는 사실을 고정했고(그 seam harness는 DELTA-05에서 제거됨), DELTA-02
// 이후로는 `operation-key.test.ts`가 이 table을 코어
// (`src/protocol/operation-key.ts`)에 직접 돌려 문법 자체를 검증하는 유일한
// 소비자다.
//
// 각 case의 `manifest`는 실제 handshake manifest와 같은 모양
// (`{ rpc, state, event }`, 각각 wire key 문자열 배열)이다. `verdict`는 그
// 전체 조합이 accept(정상 등록/handshake) 되는지 reject(생성·handshake 실패)
// 되는지를 나타낸다.
//
// `mainSkipReason`·`rendererOnly` 필드는 DELTA-01 seam harness(Main impl
// 트리로 표현 불가능한 case, Renderer 전용 형태 불일치 case를 구분해 건너뛰던
// 표시)가 남긴 이력이다 — 코어 table-driven test는 이 표시와 무관하게 모든
// case를 wire key 문자열 그대로 실행한다(DELTA-02 "## 결과" 참고).

export type OperationKeyVerdict = "accept" | "reject";

export interface OperationKeyManifest {
  readonly rpc: readonly string[];
  readonly state: readonly string[];
  readonly event: readonly string[];
}

export interface OperationKeyCase {
  readonly label: string;
  readonly manifest: OperationKeyManifest;
  readonly verdict: OperationKeyVerdict;
  /**
   * true면 Renderer만 실행한다. Main은 생성 측이라 이 형태(예: prefix와 배열
   * category 불일치)를 애초에 만들 수 없다.
   */
  readonly rendererOnly?: true;
  /**
   * 있으면 Main 실행을 건너뛴다 — Main의 impl 트리로 이 wire key(들)를
   * 표현할 수 없는 이유.
   */
  readonly mainSkipReason?: string;
  /**
   * DELTA-02: `verdict: "reject"` case에서 코어(`src/protocol/operation-key.ts`)가
   * 내는 첫 실패 이유. manifest를 `rpc`→`state`→`event` 순서, 각 배열은
   * 선언 순서로 훑으며 `parseWireKey` → (배열 category와 파싱된 category
   * 대조, 불일치면 `"category-mismatch"`) → `OperationPathTrie.add`를
   * 적용했을 때 처음 실패하는 지점의 reason이다. `"category-mismatch"`는
   * 코어가 내는 reason이 아니라 이 대조를 수행하는 호출자(테스트) 쪽 표시다.
   * accept case에는 없다.
   */
  readonly reason?:
    | "empty-segment"
    | "dotted-segment"
    | "reserved-segment"
    | "nested-operation"
    | "unknown-category"
    | "leaf-namespace-collision"
    | "duplicate-or-collision"
    | "category-mismatch";
}

const empty: readonly string[] = [];

function rpcOnly(...keys: readonly string[]): OperationKeyManifest {
  return { rpc: keys, state: empty, event: empty };
}

export const operationKeyCases: readonly OperationKeyCase[] = [
  // --- 허용 --------------------------------------------------------------
  {
    label: "허용: 단일 도메인",
    manifest: rpcOnly("rpc:device/connect"),
    verdict: "accept",
  },
  {
    label: "허용: 중첩 도메인",
    manifest: rpcOnly("rpc:a/b/op"),
    verdict: "accept",
  },
  {
    label: "허용: 카테고리 이름을 operation 이름으로 씀",
    manifest: rpcOnly("rpc:device/state"),
    verdict: "accept",
  },
  {
    label: "허용: operation 이름 'dispose'",
    manifest: rpcOnly("rpc:device/dispose"),
    verdict: "accept",
  },
  {
    label: "허용: 중첩 위치의 'dispose' 도메인 segment",
    manifest: rpcOnly("rpc:a/dispose/x"),
    verdict: "accept",
  },
  {
    label: "허용: 다른 도메인의 같은 operation 이름",
    manifest: rpcOnly("rpc:a/x", "rpc:b/x"),
    verdict: "accept",
  },
  {
    label: "허용: 'a'와 'a-x' 도메인 공존",
    manifest: rpcOnly("rpc:a/op", "rpc:a-x/op"),
    verdict: "accept",
  },

  // --- 거부(도메인 segment) ------------------------------------------------
  {
    label: "거부: 도메인의 선행 빈 segment",
    manifest: rpcOnly("rpc:/x"),
    verdict: "reject",
    reason: "empty-segment",
  },
  {
    label: "거부: 도메인 중간의 빈 segment(연속 슬래시)",
    manifest: rpcOnly("rpc:a//x"),
    verdict: "reject",
    reason: "empty-segment",
  },
  {
    label: "거부: dotted 도메인 segment",
    manifest: rpcOnly("rpc:a.b/x"),
    verdict: "reject",
    reason: "dotted-segment",
  },
  {
    label: "거부: 예약어 '__proto__' 도메인 segment",
    manifest: rpcOnly("rpc:__proto__/x"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 예약어 'prototype' 도메인 segment",
    manifest: rpcOnly("rpc:prototype/x"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 예약어 'constructor' 도메인 segment",
    manifest: rpcOnly("rpc:constructor/x"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 예약어 'then' 도메인 segment",
    manifest: rpcOnly("rpc:then/x"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: root 'dispose' 도메인 segment",
    manifest: rpcOnly("rpc:dispose/x"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 카테고리 segment(root 위치, 도메인 자체가 'rpc')",
    manifest: rpcOnly("rpc:rpc/x"),
    verdict: "reject",
    reason: "reserved-segment",
    mainSkipReason:
      "impl 트리 어느 노드에서든 key 'rpc'는 항상 그 노드의 rpc 카테고리로 " +
      "해석된다. 도메인 전체가 정확히 'rpc' 한 segment뿐이면(이웃 segment와 " +
      "묶을 수 없다) impl로 표현 자체가 불가능하다.",
  },
  {
    label: "거부: 카테고리 segment(중첩 위치, 'hardware/state')",
    manifest: { rpc: empty, state: ["state:hardware/state/x"], event: empty },
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 카테고리 segment(깊은 위치, 'hardware/event/log')",
    manifest: {
      rpc: empty,
      state: empty,
      event: ["event:hardware/event/log/x"],
    },
    verdict: "reject",
    reason: "reserved-segment",
  },

  // --- 거부(operation) -----------------------------------------------------
  {
    label: "거부: 빈 operation 이름",
    manifest: rpcOnly("rpc:a/"),
    verdict: "reject",
    reason: "empty-segment",
  },
  {
    label: "거부: dotted operation 이름",
    manifest: rpcOnly("rpc:a/b.c"),
    verdict: "reject",
    reason: "dotted-segment",
  },
  {
    label: "거부: 예약어 '__proto__' operation 이름",
    manifest: rpcOnly("rpc:a/__proto__"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 예약어 'prototype' operation 이름",
    manifest: rpcOnly("rpc:a/prototype"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 예약어 'constructor' operation 이름",
    manifest: rpcOnly("rpc:a/constructor"),
    verdict: "reject",
    reason: "reserved-segment",
  },
  {
    label: "거부: 예약어 'then' operation 이름",
    manifest: rpcOnly("rpc:a/then"),
    verdict: "reject",
    reason: "reserved-segment",
  },

  // --- 거부(형태) ------------------------------------------------------------
  {
    label: "거부: 도메인 없는 key('rpc:x', slash 없음)",
    manifest: rpcOnly("rpc:x"),
    verdict: "reject",
    reason: "empty-segment",
  },
  {
    label: "거부: prefix 없음",
    manifest: rpcOnly("hardware.connect"),
    verdict: "reject",
    reason: "unknown-category",
    mainSkipReason:
      "Main impl 트리는 카테고리(rpc/state/event) 노드를 통해서만 operation을 " +
      "등록한다 — 'category:' prefix가 아예 없는 wire key는 어느 카테고리로도 " +
      "표현할 수 없다.",
  },
  {
    label: "거부: 알 수 없는 prefix",
    manifest: rpcOnly("foo:a/x"),
    verdict: "reject",
    reason: "unknown-category",
    mainSkipReason:
      "impl 트리의 카테고리는 rpc/state/event 셋뿐이다 — 'foo:' 같은 " +
      "알 수 없는 prefix에 대응하는 카테고리 노드가 없다.",
  },

  // --- 거부(충돌) ------------------------------------------------------------
  {
    label: "거부: leaf/namespace 충돌(leaf 먼저)",
    manifest: rpcOnly("rpc:a/b", "rpc:a/b/c"),
    verdict: "reject",
    reason: "leaf-namespace-collision",
  },
  {
    label: "거부: leaf/namespace 충돌(namespace 먼저, 순서 반대)",
    manifest: rpcOnly("rpc:a/b/c", "rpc:a/b"),
    verdict: "reject",
    reason: "duplicate-or-collision",
  },
  {
    label: "거부: 같은 카테고리 완전 중복",
    manifest: rpcOnly("rpc:a/b", "rpc:a/b"),
    verdict: "reject",
    reason: "duplicate-or-collision",
    mainSkipReason:
      "impl 트리의 operation은 JS 객체 key라 유일하다 — 같은 경로를 같은 " +
      "카테고리에 두 번 등록하는 impl을 구성할 수 없다(두 번째가 첫 번째를 " +
      "덮어써 단일 등록이 된다).",
  },
  {
    label: "거부: 카테고리 간 중복(rpc·state 같은 경로)",
    manifest: { rpc: ["rpc:a/x"], state: ["state:a/x"], event: empty },
    verdict: "reject",
    reason: "duplicate-or-collision",
  },
  {
    label: "거부: 카테고리 간 leaf/namespace 충돌(rpc·event)",
    manifest: { rpc: ["rpc:a/b"], state: empty, event: ["event:a/b/c"] },
    verdict: "reject",
    reason: "leaf-namespace-collision",
  },

  // --- Renderer 전용 -----------------------------------------------------
  {
    label: "거부(Renderer 전용): prefix와 배열 category 불일치",
    manifest: rpcOnly("state:a/x"),
    verdict: "reject",
    rendererOnly: true,
    reason: "category-mismatch",
  },
];
