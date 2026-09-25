/**
 * `rejected` 진단의 `key` 포함 규칙(ADR 0010 §6)이 타입으로 강제되는지 확인한다.
 * 등록 조회 뒤 사유는 `key`가 필수이고, 조회 전 사유는 `key`를 가질 수 없으며,
 * 두 경로에서 나오는 `invalid-input`만 `key`가 선택이다. 컴파일만 검증하고
 * 런타임 기록은 `diagnostics-rejections.test.ts`가 다룬다.
 */
import { expectTypeOf, test } from "vitest";

import type { BridgeDiagnostic } from "../../src/main/index.js";

test("등록 조회 뒤 사유는 key 없이 만들 수 없다", () => {
  const withKey: BridgeDiagnostic = {
    type: "rejected",
    reason: "rpc-limit",
    key: "rpc:app/save",
  };
  // @ts-expect-error -- rpc-limit은 key가 필수다.
  const withoutKey: BridgeDiagnostic = {
    type: "rejected",
    reason: "rpc-limit",
  };
  void withKey;
  void withoutKey;
});

test("등록 조회 전 사유는 key를 가질 수 없다", () => {
  const withoutKey: BridgeDiagnostic = {
    type: "rejected",
    reason: "unknown-operation",
  };
  const withKey: BridgeDiagnostic = {
    type: "rejected",
    reason: "unknown-operation",
    // @ts-expect-error -- unknown-operation은 key를 싣지 않는다.
    key: "rpc:app/save",
  };
  void withoutKey;
  void withKey;
});

test("invalid-input은 key가 있어도 없어도 된다", () => {
  const rpcInput: BridgeDiagnostic = {
    type: "rejected",
    reason: "invalid-input",
    key: "rpc:app/save",
  };
  const subscriptionId: BridgeDiagnostic = {
    type: "rejected",
    reason: "invalid-input",
  };
  void rpcInput;
  void subscriptionId;
});

test("sink가 reason으로 좁히면 key 타입이 사유에 맞게 정해진다", () => {
  const record = (event: BridgeDiagnostic): void => {
    if (event.type !== "rejected") return;
    if (event.reason === "authorize-denied")
      expectTypeOf(event.key).toEqualTypeOf<string>();
    if (event.reason === "malformed-envelope")
      expectTypeOf(event.key).toEqualTypeOf<undefined>();
    if (event.reason === "invalid-input")
      expectTypeOf(event.key).toEqualTypeOf<string | undefined>();
  };
  void record;
});
