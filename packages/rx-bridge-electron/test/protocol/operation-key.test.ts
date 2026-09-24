/**
 * operation key 코어(`src/protocol/operation-key.ts`)의 규칙 test.
 * `operation-key-cases.ts`의 case table을 코어 함수로 직접 판정하고, reject
 * case는 첫 실패 `reason`까지 대조한다. Main·Renderer seam test는 호출자가
 * 이 코어를 실제로 쓰는지만 대표 건으로 확인한다.
 *
 * `evaluateManifest`는 Renderer manifest 파서와 같은 절차(parse → 배열
 * category 대조 → trie)를 코어 함수만으로 재구성한다.
 */
import { describe, expect, test } from "vitest";

import {
  checkDomainSegments,
  checkOperationName,
  checkSegment,
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
      expect(failures[0]?.reason).toBe(caseEntry.reason);
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

  test("checkSegment는 위치 무관 규칙만 본다(root dispose·카테고리 이름 허용)", () => {
    expect(checkSegment("dispose")).toEqual({ ok: true });
    expect(checkSegment("rpc")).toEqual({ ok: true });
    expect(checkSegment("then")).toEqual({
      ok: false,
      reason: "reserved-segment",
      segment: "then",
    });
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
