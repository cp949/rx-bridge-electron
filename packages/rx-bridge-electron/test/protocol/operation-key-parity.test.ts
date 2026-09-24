// RD-017 DELTA-01: `operation-key-cases.ts`의 공유 case table을 Main
// seam(`createBridgeServer` impl 등록)과 Renderer seam(`createRendererApi`
// handshake 파싱) 양쪽에 그대로 돌려, 교체 전 두 구현이 같은 wire key
// 집합에 같은 판정(accept/reject)을 낸다는 사실을 고정한다. 이 harness는
// DELTA-03·04(Main·Renderer를 `src/protocol/operation-key.ts` 코어로
// 교체)가 "test 내용 변경 0"으로 끝날 수 있게 하는 안전망이고, DELTA-05에서
// 코어 table-driven test로 옮겨 가며 여기의 seam 실행분은 축소된다.
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test } from "vitest";

import {
  broadcastEvent,
  createBridgeServer,
  currentValueSource,
} from "../../src/main/index.js";
import { createRendererApi } from "../../src/renderer/index.js";
import { FakeTarget, sender } from "../main/fake-ipc.js";
import { FakeTransport } from "../renderer/fake-transport.js";
import {
  operationKeyCases,
  type OperationKeyCase,
} from "./operation-key-cases.js";

type Category = "rpc" | "state" | "event";
type ImplNode = Record<string, unknown>;

const RESERVED_CATEGORY_SEGMENTS = new Set<string>(["rpc", "state", "event"]);

/**
 * `Object.defineProperty`로 own data property를 만든다. 일반 대입(`obj[key] =
 * value`)이나 object literal의 리터럴 `__proto__` key는 `__proto__`를
 * prototype setter로 취급해 own property가 되지 않는다 — 이 helper는 그
 * 함정을 피해 어떤 문자열 key(빈 문자열·`__proto__` 포함)든 항상 진짜
 * own property로 만든다.
 */
function setOwn(target: ImplNode, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function ensureChild(target: ImplNode, key: string): ImplNode {
  const existing = Object.getOwnPropertyDescriptor(target, key)?.value;
  if (typeof existing === "object" && existing !== null) {
    return existing as ImplNode;
  }
  const child: ImplNode = {};
  setOwn(target, key, child);
  return child;
}

/**
 * 도메인 segment 배열을 impl 트리의 "레벨"(object 중첩 단계) 배열로 만든다.
 * `walkImplNode`는 어느 노드에서든 key가 정확히 'rpc'/'state'/'event'이면
 * 그 노드의 카테고리로 해석해 버린다 — 그래서 도메인 segment 자체가 카테고리
 * 이름(예: 'state')이면 단독 object key로 만들 수 없다. 이웃 segment와
 * 하나의 key로 묶어("hardware/state") 그 모호성을 피한다(기존
 * `create-bridge-server-impl.test.ts`의 "reserved 'state' segment nested"
 * case와 같은 기법). 묶을 이웃이 없는 경우(카테고리 이름 segment가 도메인의
 * 유일한 segment)는 애초에 표현할 수 없다 — 그런 case는 `mainSkipReason`으로
 * 건너뛴다.
 */
function buildDomainLevels(domainSegments: readonly string[]): string[] {
  const levels: string[] = [];
  for (const segment of domainSegments) {
    if (RESERVED_CATEGORY_SEGMENTS.has(segment) && levels.length > 0) {
      levels[levels.length - 1] = `${levels[levels.length - 1]}/${segment}`;
    } else {
      levels.push(segment);
    }
  }
  return levels;
}

function insertLeaf(
  root: ImplNode,
  category: Category,
  path: string,
  leaf: unknown,
): void {
  const segments = path.split("/");
  const domainSegments = segments.slice(0, -1);
  const operation = segments[segments.length - 1]!;
  const levels = buildDomainLevels(domainSegments);
  let node = root;
  for (const level of levels) node = ensureChild(node, level);
  const categoryNode = ensureChild(node, category);
  setOwn(categoryNode, operation, leaf);
}

function rpcLeaf(): () => number {
  return () => 1;
}

function stateLeaf(): unknown {
  return currentValueSource(new BehaviorSubject(0));
}

function eventLeaf(): unknown {
  return broadcastEvent(new Subject<number>());
}

/**
 * case의 `manifest`(카테고리별 wire key 배열)로부터 Main impl 트리를 만든다.
 * 각 wire key는 자기 카테고리 bucket의 prefix(`${category}:`)와 일치해야
 * 한다 — 일치하지 않는 case(prefix 없음, 알 수 없는 prefix, category 불일치)는
 * `mainSkipReason`/`rendererOnly`로 표시돼 있어야 하며 이 함수까지 오면 안
 * 된다(호출 전에 건너뛴다).
 */
function buildMainImpl(caseEntry: OperationKeyCase): unknown {
  const root: ImplNode = {};
  const categories: readonly Category[] = ["rpc", "state", "event"];
  for (const category of categories) {
    const prefix = `${category}:`;
    for (const key of caseEntry.manifest[category]) {
      if (!key.startsWith(prefix)) {
        throw new Error(
          `case '${caseEntry.label}': wire key '${key}'는 '${category}' bucket의 ` +
            "prefix와 맞지 않는다 — mainSkipReason 또는 rendererOnly로 표시해야 한다.",
        );
      }
      const path = key.slice(prefix.length);
      const leaf =
        category === "rpc"
          ? rpcLeaf()
          : category === "state"
            ? stateLeaf()
            : eventLeaf();
      insertLeaf(root, category, path, leaf);
    }
  }
  return root;
}

function allKeys(manifest: OperationKeyCase["manifest"]): Set<string> {
  return new Set([...manifest.rpc, ...manifest.state, ...manifest.event]);
}

describe("operation key parity: Main seam(createBridgeServer impl 등록)", () => {
  for (const caseEntry of operationKeyCases) {
    const skipReason = caseEntry.rendererOnly
      ? "Renderer 전용 case — Main은 생성 측이라 해당 형태를 만들 수 없다."
      : caseEntry.mainSkipReason;
    if (skipReason !== undefined) {
      test.skip(`${caseEntry.label} (건너뜀: ${skipReason})`, () => {
        // impl 트리로 표현할 수 없는 case. 이유는 skip 사유와 label에 남긴다.
      });
      continue;
    }

    test(caseEntry.label, () => {
      const impl = buildMainImpl(caseEntry);
      if (caseEntry.verdict === "reject") {
        expect(() => createBridgeServer(impl as never)).toThrow(TypeError);
        return;
      }
      const server = createBridgeServer(impl as never);
      server.attach(new FakeTarget());
      const handshake = server.handshake(sender(), "document-1");
      if (handshake === undefined) throw new Error("expected a handshake");
      expect(allKeys(handshake.manifest)).toEqual(allKeys(caseEntry.manifest));
    });
  }
});

describe("operation key parity: Renderer seam(createRendererApi handshake 파싱)", () => {
  for (const caseEntry of operationKeyCases) {
    test(caseEntry.label, async () => {
      const transport = new FakeTransport();
      transport.handshake = Promise.resolve({
        protocolVersion: 1,
        clientId: "client-1",
        manifest: {
          rpc: caseEntry.manifest.rpc,
          state: caseEntry.manifest.state,
          event: caseEntry.manifest.event,
        },
      });

      if (caseEntry.verdict === "accept") {
        await expect(
          createRendererApi<Record<string, never>>(transport),
        ).resolves.toBeDefined();
      } else {
        await expect(
          createRendererApi<Record<string, never>>(transport),
        ).rejects.toMatchObject({ code: "INTERNAL" });
      }
    });
  }
});
