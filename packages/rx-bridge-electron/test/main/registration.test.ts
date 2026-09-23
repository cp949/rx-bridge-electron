import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

// DELTA-07: 이 파일은 원래 descriptor 기반 registerImplementations/
// normalizeImplementation("구현 배열을 계약과 대조" 모델) 자체의 런타임
// 검증을 다뤘다(DELTA-09에서 descriptor API 자체가 제거됐다). 그 중 다음 두
// 부류는 이번 DELTA에서 옮기지 않았다(각각 사유):
//
// 1. "선언된 도메인 구현이 배열에 없음/중복/다른 모양으로 재선언" 계열 — 계약과
//    구현을 분리해 배열로 등록하는 descriptor API 고유의 아키텍처에서만 의미가
//    있다. impl 기반 API는 단일 impl 트리가 유일한 진실 소스라 "선언은 있는데
//    구현이 없다/중복 등록됐다"는 상태 자체가 있을 수 없다 — 대응 개념이 없다.
// 2. "raw 구현이 선언된 handler/source를 빠뜨렸다/모르는 걸 추가했다"(Missing/
//    Undeclared RPC handler·State source·Event source) — impl 트리에는 별도
//    "선언"이 없으므로 이 구분 자체가 없다. 같은 취지의 정적 검사는 이미
//    `test/contract/bridge-types.test.ts`(DELTA-02)의 누락/초과 키 `@ts-expect-error`
//    케이스가 타입 단계에서 커버한다.
//
// "형태 오류"(RPC handler가 함수가 아님·State source에 현재값이 없음·Event
// source가 Observable/adapter가 아님) 계열은 `create-bridge-server-impl.test.ts`의
// "impl 형태 오류는 생성 시점에 실패한다" describe 블록이 이미 impl 기반 API
// 기준으로 같은 메시지를 검증하므로 여기서도 다시 옮기지 않았다.
//
// 아래 남은 테스트들은 impl 기반 API에서도 여전히 의미가 있다: 카테고리 값이
// null인 경우, 등록 실패 시 어떤 source도 구독하지 않는 원자성, manifest에
// 실린 모든 operation이 실제로 dispatch/subscribe 가능함, 원본 impl 객체를
// 나중에 변형해도 이미 만든 서버에 영향이 없음.

const rpcRequest = (
  key: string,
  input: number,
  clientId = "document-1",
  requestId = "request-1",
) => ({
  protocolVersion: 1 as const,
  clientId,
  requestId,
  key,
  input,
});

describe("createBridgeServer(impl): 등록 형태 검증", () => {
  test("카테고리 값이 null이면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        hardware: {
          rpc: { ping: () => 1 },
          state: null,
        },
      }),
    ).toThrow(/state implementations for 'hardware' must be an object\./);
  });

  test("등록이 실패하면 어떤 source도 구독하지 않는다(원자성)", () => {
    const source = new BehaviorSubject(1);
    const subscribeSpy = vi.spyOn(source, "subscribe");
    expect(() =>
      createBridgeServer({
        alphaBad: { rpc: { op1: "not-a-function" } },
        betaGood: { state: { current$: currentValueSource(source) } },
      }),
    ).toThrow(/RPC handler 'alphaBad\/op1' must be a function\./);
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});

type AlphaBetaBridge = {
  alpha: {
    rpc: { op1(input: number): number };
    state: { current$: number };
    event: { change$: number };
  };
  beta: {
    rpc: { op2(input: number): number };
  };
};

describe("createBridgeServer(impl): manifest과 실제 dispatch/subscribe의 일치", () => {
  test("manifest에 실린 모든 operation이 NOT_FOUND 없이 dispatch/subscribe된다", async () => {
    const alphaSource = new BehaviorSubject(1);
    const alphaEvents = new Subject<number>();
    const impl: BridgeImpl<AlphaBetaBridge> = {
      alpha: {
        rpc: { op1: async (input) => input },
        state: { current$: currentValueSource(alphaSource) },
        event: { change$: broadcastEvent(alphaEvents) },
      },
      beta: { rpc: { op2: async (input) => input } },
    };
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    const handshake = server.handshake(sender(), "document-1");
    if (handshake === undefined) throw new Error("expected a handshake");
    const manifest = handshake.manifest;
    for (const key of manifest.rpc) {
      const response = await server.dispatchRpc(sender(), rpcRequest(key, 1));
      expect(response).not.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    let sequence = 0;
    for (const key of [...manifest.state, ...manifest.event]) {
      const messages: { type: string }[] = [];
      sequence += 1;
      await server.controlStream(
        sender(),
        {
          protocolVersion: 1,
          clientId: "document-1",
          type: "subscribe",
          subscriptionId: testSubscriptionId(sequence),
          key,
        },
        (message) => messages.push(message),
      );
      expect(
        messages.some(
          (message) =>
            message.type === "error" &&
            (message as { error?: { code?: string } }).error?.code ===
              "NOT_FOUND",
        ),
      ).toBe(false);
    }
  });

  test("나중에 원본 impl 객체를 변형해도 이미 만든 서버는 영향받지 않는다", async () => {
    const original = vi.fn(async (input: number) => input);
    const replacement = vi.fn(async (input: number) => input * 2);
    const rpcRecord: Record<string, unknown> = { op1: original };
    const server = createBridgeServer({ alpha: { rpc: rpcRecord } });
    rpcRecord.op1 = replacement;
    server.attach(new FakeTarget());
    await server.dispatchRpc(sender(), rpcRequest("rpc:alpha/op1", 1));
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
});
