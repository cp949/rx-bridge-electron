// RD-017: `operation-key-cases.ts`의 공유 case table을 코어
// `src/protocol/operation-key.ts`에 직접 돌린다. 이 파일은 코어
// 함수(`parseWireKey`·`checkDomainSegments`·`checkOperationName`·
// `OperationPathTrie`)를 직접 호출해 판정을 낸다는 것과, 각 reject
// case의 verdict `reason`이 case table에 적어 둔 값과 같다는 것을 고정한다.
// DELTA-01에서는 Main·Renderer "seam"(impl 등록, handshake 파싱)을 통해
// 간접으로 이 table을 검증하는 harness(`operation-key-parity.test.ts`)가
// 함께 있었지만, DELTA-05에서 그 harness를 제거하고 규칙 검증은 이 파일
// 하나로 모았다 — Main·Renderer는 이제 대표 seam test 몇 건으로만 "코어를
// 실제로 호출한다"는 사실을 확인한다(`test/main/create-bridge-server-impl.test.ts`,
// `test/renderer/rpc-client.test.ts`).
//
// manifest 한 건을 판정하는 절차는 `rpc`→`state`→`event` 순서, 각 배열은
// 선언 순서로 모든 key를 훑으며: `parseWireKey` → (파싱된 category가 그
// key가 속한 배열의 category와 같은지 대조 — 다르면 `"category-mismatch"`,
// Renderer 전용 검사) → `OperationPathTrie.add`. 이 절차에서 첫 실패가
// 나오면 그 reason을 기록하고 멈춘다(같은 manifest에 실패가 여럿이어도
// 첫 번째만 본다 — case table도 그렇게 설계돼 있다).
import { describe, expect, test } from "vitest";

import {
  checkDomainSegments,
  checkOperationName,
  formatWireKey,
  OperationPathTrie,
  parseWireKey,
  type OperationCategory,
} from "../../src/protocol/operation-key.js";
import {
  operationKeyCases,
  type OperationKeyCase,
} from "./operation-key-cases.js";

const CATEGORIES: readonly OperationCategory[] = ["rpc", "state", "event"];

interface EvaluationFailure {
  readonly key: string;
  readonly reason: string;
}

/**
 * case의 manifest 전체를 코어로 판정한다. 실패가 있으면 첫 실패만
 * `failures[0]`에 담는다(그 뒤 key는 평가하지 않는다) — case table의 reject
 * case가 모두 "정확히 한 지점에서 처음 걸린다"는 전제와 맞춘다.
 */
function evaluateManifest(
  caseEntry: OperationKeyCase,
): readonly EvaluationFailure[] {
  const trie = new OperationPathTrie();
  const failures: EvaluationFailure[] = [];

  outer: for (const bucket of CATEGORIES) {
    for (const key of caseEntry.manifest[bucket]) {
      const parsed = parseWireKey(key);
      if (!parsed.ok) {
        failures.push({ key, reason: parsed.reason });
        break outer;
      }
      if (parsed.category !== bucket) {
        failures.push({ key, reason: "category-mismatch" });
        break outer;
      }
      const pathVerdict = trie.add([...parsed.domain, parsed.operation]);
      if (!pathVerdict.ok) {
        failures.push({ key, reason: pathVerdict.reason });
        break outer;
      }
    }
  }
  return failures;
}

describe("operation-key 코어: case table 판정", () => {
  for (const caseEntry of operationKeyCases) {
    test(caseEntry.label, () => {
      const failures = evaluateManifest(caseEntry);
      if (caseEntry.verdict === "accept") {
        expect(failures).toEqual([]);
        return;
      }
      expect(failures.length).toBeGreaterThan(0);
      if (caseEntry.reason !== undefined) {
        expect(failures[0]?.reason).toBe(caseEntry.reason);
      }
    });
  }
});

describe("operation-key 코어: formatWireKey ↔ parseWireKey round-trip", () => {
  for (const caseEntry of operationKeyCases) {
    test(caseEntry.label, () => {
      for (const bucket of CATEGORIES) {
        for (const key of caseEntry.manifest[bucket]) {
          const parsed = parseWireKey(key);
          if (!parsed.ok) continue;
          expect(
            formatWireKey(parsed.category, parsed.domain, parsed.operation),
          ).toBe(key);
        }
      }
    });
  }
});

describe("operation-key 코어: checkDomainSegments·checkOperationName 직접 호출", () => {
  test("빈 도메인 배열은 빈 segment 하나로 취급한다", () => {
    expect(checkDomainSegments([])).toEqual({
      ok: false,
      reason: "empty-segment",
      segment: "",
    });
  });

  test("허용 도메인은 ok:true", () => {
    expect(checkDomainSegments(["a", "b"])).toEqual({ ok: true });
  });

  test("중첩 dispose 도메인은 허용된다", () => {
    expect(checkDomainSegments(["a", "dispose"])).toEqual({ ok: true });
  });

  test("root dispose 도메인은 reserved-segment로 거부된다", () => {
    expect(checkDomainSegments(["dispose"])).toEqual({
      ok: false,
      reason: "reserved-segment",
      segment: "dispose",
    });
  });

  test("operation 이름에 슬래시가 있으면 nested-operation으로 거부된다", () => {
    expect(checkOperationName("a/b")).toEqual({
      ok: false,
      reason: "nested-operation",
    });
  });

  test("허용 operation 이름은 ok:true", () => {
    expect(checkOperationName("connect")).toEqual({ ok: true });
  });
});

describe("operation-key 코어: OperationPathTrie", () => {
  test("겹치지 않는 경로는 모두 허용된다", () => {
    const trie = new OperationPathTrie();
    expect(trie.add(["a", "x"])).toEqual({ ok: true });
    expect(trie.add(["b", "x"])).toEqual({ ok: true });
  });

  test("leaf 등록 뒤 그 하위 경로를 추가하면 leaf-namespace-collision", () => {
    const trie = new OperationPathTrie();
    expect(trie.add(["a", "b"])).toEqual({ ok: true });
    expect(trie.add(["a", "b", "c"])).toEqual({
      ok: false,
      reason: "leaf-namespace-collision",
    });
  });

  test("namespace 등록 뒤 그 자리에 leaf를 추가하면 duplicate-or-collision", () => {
    const trie = new OperationPathTrie();
    expect(trie.add(["a", "b", "c"])).toEqual({ ok: true });
    expect(trie.add(["a", "b"])).toEqual({
      ok: false,
      reason: "duplicate-or-collision",
    });
  });

  test("같은 경로를 두 번 추가하면 duplicate-or-collision", () => {
    const trie = new OperationPathTrie();
    expect(trie.add(["a", "b"])).toEqual({ ok: true });
    expect(trie.add(["a", "b"])).toEqual({
      ok: false,
      reason: "duplicate-or-collision",
    });
  });
});
