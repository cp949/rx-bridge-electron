// DELTA-05(RD-012): `createBridgeServer(impl, options)`의 `schemas`·`errors`
// map이 operation 단위 부분·점진 적용과 정확한 실패 분류를 지키는지 검증한다.
// `.scratch/lightweight-contract/spec.md`의 확정 결정 3(요청 처리 순서:
// `parseBridgeValue(input)` → 입력 스키마 → handler → 출력 스키마 →
// `parseBridgeValue`+clone)·5(errors map, 목록 밖 코드는 안전한 오류)를
// 새 impl 기반 API 기준으로 확인한다. DELTA-03/04가 이미 배선해 둔 공유
// dispatcher(`rpc-dispatcher.ts`)·`output-boundary.ts`·`stream-hub.ts`가
// descriptor 경로와 같은 동작을 내는지가 핵심이다.
import { describe, expect, test } from "vitest";

import {
  createBridgeServer,
  type BridgeDiagnostic,
} from "../../src/main/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { buildAppBridgeImpl, errors, schemas } from "./impl-schemas-fixture.js";
import { testSubscriptionId } from "./subscription-ids.js";

/** diagnostics 기록을 배열로 모으는 sink. 테스트마다 새로 만든다. */
function collectDiagnostics(): {
  readonly diagnostics: { record(event: BridgeDiagnostic): void };
  readonly records: BridgeDiagnostic[];
} {
  const records: BridgeDiagnostic[] = [];
  return { diagnostics: { record: (event) => records.push(event) }, records };
}

const messageTypes = (messages: readonly StreamMessage[]) =>
  messages.map((message) => message.type);

describe("schemas map: 입력 스키마의 부분 적용", () => {
  test("입력 스키마가 없는 RPC(connect)는 검증 없이 통과한다", async () => {
    const { diagnostics } = collectDiagnostics();
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors, diagnostics });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/connect",
      input: undefined,
    });

    expect(response).toMatchObject({ type: "success", result: { ok: true } });
  });

  test("입력 스키마가 있는 RPC(send)는 유효한 입력을 통과시킨다", async () => {
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/send",
      input: { command: "abc" },
    });

    expect(response).toMatchObject({
      type: "success",
      result: { bytesWritten: 3 },
    });
  });

  test("입력 스키마 검증 실패는 INVALID_ARGUMENT 응답과 diagnostics rejected/invalid-input을 남긴다", async () => {
    const { diagnostics, records } = collectDiagnostics();
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors, diagnostics });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/send",
      input: { command: "" },
    });

    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(response).not.toHaveProperty("result");
    expect(records).toContainEqual({
      type: "rejected",
      reason: "invalid-input",
      key: "rpc:device/send",
    });
  });
});

describe("schemas map: 출력 스키마의 부분 적용", () => {
  test("출력 스키마가 없는 RPC(send)는 handler 결과를 그대로 반환한다", async () => {
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/send",
      input: { command: "abcd" },
    });

    expect(response).toMatchObject({
      type: "success",
      result: { bytesWritten: 4 },
    });
  });

  test("출력 스키마(echo)가 변환한 값을 그대로 응답에 쓴다(RD-004 재검사 유지)", async () => {
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/echo",
      input: { value: 5 },
    });

    // handler는 input을 그대로 돌려주지만(value: 5), echo의 출력 스키마가
    // value를 2배로 변환한다 — 응답이 handler 결과가 아니라 스키마의
    // 변환 결과임을 확인한다.
    expect(response).toMatchObject({
      type: "success",
      result: { value: 10 },
    });
  });

  test("출력 스키마의 변환 결과가 BridgeValue 경계를 어기면(순환 참조) INTERNAL과 diagnostics validation-failed를 남긴다", async () => {
    const { diagnostics, records } = collectDiagnostics();
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors, diagnostics });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/cyclic",
      input: undefined,
    });

    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(response).not.toHaveProperty("result");
    expect(records).toContainEqual({
      type: "validation-failed",
      key: "rpc:device/cyclic",
    });
  });
});

describe("schemas map: State·Event 출력 스키마", () => {
  test("출력 스키마가 없는 State(connection)는 값을 그대로 전달한다", async () => {
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:device/connection",
      },
      (message) => messages.push(message),
    );

    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
    expect(messages[1]).toMatchObject({ values: [{ ok: true }] });
  });

  test("출력 스키마가 있는 State(count)는 유효한 값을 통과시킨다", async () => {
    const { impl } = buildAppBridgeImpl({ initialCount: 7 });
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:device/count",
      },
      (message) => messages.push(message),
    );

    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
    expect(messages[1]).toMatchObject({ values: [7] });
  });

  test("State 출력 스키마 검증 실패는 구독을 INTERNAL 오류로 종료한다", async () => {
    const { diagnostics, records } = collectDiagnostics();
    const { impl } = buildAppBridgeImpl({ initialCount: Number.NaN });
    const server = createBridgeServer(impl, { schemas, errors, diagnostics });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:device/count",
      },
      (message) => messages.push(message),
    );

    expect(messageTypes(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(records).toContainEqual({
      type: "validation-failed",
      key: "state:device/count",
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("출력 스키마가 없는 Event(data)는 값을 그대로 전달한다", async () => {
    const { impl, dataEvents } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/data",
      },
      (message) => messages.push(message),
    );
    dataEvents.next({ text: "hello" });

    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
    expect(messages[1]).toMatchObject({ values: [{ text: "hello" }] });
  });

  test("출력 스키마가 있는 Event(alerts)는 유효한 값을 통과시킨다", async () => {
    const { impl, alertEvents } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/alerts",
      },
      (message) => messages.push(message),
    );
    alertEvents.next({ level: "warn", text: "low battery" });

    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
    expect(messages[1]).toMatchObject({
      values: [{ level: "warn", text: "low battery" }],
    });
  });

  test("Event 출력 스키마 검증 실패는 해당 구독을 INTERNAL 오류로 종료한다", async () => {
    const { diagnostics, records } = collectDiagnostics();
    const { impl, alertEvents } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors, diagnostics });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/alerts",
      },
      (message) => messages.push(message),
    );
    alertEvents.next({ level: "bogus" as never, text: "invalid" });
    // 구독이 종료된 뒤 이어지는 유효한 값은 더 이상 전달되지 않는다.
    alertEvents.next({ level: "info", text: "should not arrive" });

    expect(messageTypes(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
    expect(records).toContainEqual({
      type: "validation-failed",
      key: "event:device/alerts",
    });
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });
});

describe("errors map: 허용 코드 목록 밖은 안전한 오류로 바뀐다", () => {
  test("options.errors에 선언한 코드는 그대로 전달된다", async () => {
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/boom",
      input: { code: "DEVICE_BUSY" },
    });

    expect(response).toMatchObject({
      type: "error",
      error: { code: "DEVICE_BUSY" },
    });
  });

  test("목록에 없는 코드는 INTERNAL로 치환된다", async () => {
    const { impl } = buildAppBridgeImpl();
    const server = createBridgeServer(impl, { schemas, errors });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/boom",
      input: { code: "SOMETHING_ELSE" },
    });

    expect(response).toMatchObject({
      type: "error",
      error: { code: "INTERNAL", message: "Internal bridge error." },
    });
  });
});
