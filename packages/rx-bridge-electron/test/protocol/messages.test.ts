import { describe, expect, test } from "vitest";

import {
  parseHandshakeRequest,
  parseHandshakeResponse,
  parseRendererRpcRequest,
  parseRendererStreamCommand,
  parseRpcResponse,
  parseWireCancelRequest,
  parseWireRpcRequest,
  parseWireStreamCommand,
} from "../../src/protocol/messages.js";

const limits = {
  maxDepth: 4,
  maxEntries: 16,
  maxStringBytes: 32,
};

describe("protocol envelope parsers", () => {
  test("accepts a protocol version 1 request and manifest-bearing response", () => {
    expect(
      parseHandshakeRequest(
        { protocolVersion: 1, clientId: "client-1" },
        limits,
      ),
    ).toEqual({
      protocolVersion: 1,
      clientId: "client-1",
    });
    expect(
      parseHandshakeResponse(
        {
          protocolVersion: 1,
          clientId: "client-1",
          manifest: { rpc: ["rpc:device/ping"], state: [], event: [] },
        },
        limits,
      ),
    ).toEqual({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: { rpc: ["rpc:device/ping"], state: [], event: [] },
    });
  });

  test("rejects a renderer RPC request that attempts to supply trusted routing fields", () => {
    expect(() =>
      parseRendererRpcRequest(
        {
          requestId: "request-1",
          key: "rpc:hardware/connect",
          input: { deviceId: "device-1" },
          clientId: "forged-client",
        },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects a wire RPC request with a missing request ID", () => {
    expect(() =>
      parseWireRpcRequest(
        {
          protocolVersion: 1,
          clientId: "client-1",
          key: "rpc:hardware/connect",
          input: undefined,
        },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects an unsupported protocol version", () => {
    expect(() =>
      parseWireCancelRequest(
        { protocolVersion: 2, clientId: "client-1", requestId: "request-1" },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "VERSION_MISMATCH" }));
  });

  test("rejects an unknown stream command discriminant", () => {
    expect(() =>
      parseRendererStreamCommand(
        { type: "resume", subscriptionId: "sub-1" },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects a stream subscription without its ID", () => {
    expect(() =>
      parseRendererStreamCommand(
        { type: "subscribe", key: "state:hardware/connection" },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects a non-integer stream acknowledgement sequence", () => {
    expect(() =>
      parseWireStreamCommand(
        {
          protocolVersion: 1,
          clientId: "client-1",
          type: "acknowledge",
          subscriptionId: "sub-1",
          sequence: 1.5,
        },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects an RPC error response with malformed details", () => {
    expect(() =>
      parseRpcResponse(
        {
          protocolVersion: 1,
          clientId: "client-1",
          type: "error",
          requestId: "request-1",
          error: {
            code: "FORBIDDEN",
            message: "Not allowed",
            details: new Date(),
          },
        },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("parses an RPC response with its wire session envelope", () => {
    expect(
      parseRpcResponse(
        {
          protocolVersion: 1,
          clientId: "client-1",
          type: "success",
          requestId: "request-1",
          result: { connected: true },
        },
        limits,
      ),
    ).toEqual({
      protocolVersion: 1,
      clientId: "client-1",
      type: "success",
      requestId: "request-1",
      result: { connected: true },
    });
  });

  test("rejects an RPC response with an unsupported wire version", () => {
    expect(() =>
      parseRpcResponse(
        {
          protocolVersion: 2,
          clientId: "client-1",
          type: "success",
          requestId: "request-1",
          result: undefined,
        },
        limits,
      ),
    ).toThrowError(expect.objectContaining({ code: "VERSION_MISMATCH" }));
  });
});
