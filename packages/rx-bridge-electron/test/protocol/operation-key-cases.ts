/**
 * operation key(wire key `category:domain/op`) 문법의 accept/reject 판정
 * case table이다. `operation-key.test.ts`가 코어(`src/protocol/operation-key.ts`)에
 * 직접 돌린다.
 *
 * 각 case의 `manifest`는 handshake manifest와 같은 모양(`{ rpc, state, event }`,
 * 각각 wire key 배열)이다. reject case의 `reason`은 manifest를 `rpc`→`state`→
 * `event` 순서, 배열 안에서는 선언 순서로 훑으며 `parseWireKey` → 배열
 * category 대조 → `OperationPathTrie.add`를 적용했을 때 처음 실패하는 지점의
 * 이유다. `"category-mismatch"`는 코어가 아니라 배열 category를 대조하는
 * 호출자(Renderer manifest 파서)의 판정이다.
 */

export interface OperationKeyManifest {
  readonly rpc: readonly string[];
  readonly state: readonly string[];
  readonly event: readonly string[];
}

export type OperationKeyCaseReason =
  | "empty-segment"
  | "dotted-segment"
  | "reserved-segment"
  | "nested-operation"
  | "unknown-category"
  | "leaf-namespace-collision"
  | "duplicate-or-collision"
  | "category-mismatch";

export type OperationKeyCase =
  | {
      readonly label: string;
      readonly manifest: OperationKeyManifest;
      readonly verdict: "accept";
    }
  | {
      readonly label: string;
      readonly manifest: OperationKeyManifest;
      readonly verdict: "reject";
      readonly reason: OperationKeyCaseReason;
    };

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
  },
  {
    label: "거부: 알 수 없는 prefix",
    manifest: rpcOnly("foo:a/x"),
    verdict: "reject",
    reason: "unknown-category",
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
    reason: "category-mismatch",
  },
];
