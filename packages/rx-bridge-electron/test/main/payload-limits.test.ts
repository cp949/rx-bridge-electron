// payload-limits.ts의 기본값·부분 병합·검증·동결을 다룬다.
// `createBridgeServer`를 거치는 배선 검증은 create-bridge-server-impl.test.ts에
// 있다(RD-038의 명시적 undefined 거부 test 포함). 이 파일은
// `resolvePayloadLimits`/`DEFAULT_PAYLOAD_LIMITS`를 직접 test한다.
import { describe, expect, test } from "vitest";

import {
  DEFAULT_PAYLOAD_LIMITS,
  resolvePayloadLimits,
} from "../../src/main/payload-limits.js";

describe("resolvePayloadLimits", () => {
  test("옵션이 없으면 DEFAULT_PAYLOAD_LIMITS를 그대로(참조 동일성) 반환한다", () => {
    expect(resolvePayloadLimits(undefined)).toBe(DEFAULT_PAYLOAD_LIMITS);
  });

  test("빈 객체를 주면 기본값과 값이 같은 새 객체를 반환한다", () => {
    const resolved = resolvePayloadLimits({});
    expect(resolved).toEqual(DEFAULT_PAYLOAD_LIMITS);
    expect(resolved).not.toBe(DEFAULT_PAYLOAD_LIMITS);
  });

  test("지정하지 않은 필드는 기본값을 유지한다", () => {
    const input = { maxDepth: 4 };
    const resolved = resolvePayloadLimits(input);
    expect(resolved).toEqual({ ...DEFAULT_PAYLOAD_LIMITS, maxDepth: 4 });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(input).toEqual({ maxDepth: 4 });
  });

  test.each([
    ["maxDepth", 0],
    ["maxEntries", 0],
    ["maxStringBytes", 0],
    ["maxTotalBytes", 0],
    ["maxTotalBytes", Number.MAX_SAFE_INTEGER],
  ])("%s = %p는 허용한다", (key, value) => {
    expect(
      resolvePayloadLimits({ [key]: value } as never)[
        key as keyof typeof DEFAULT_PAYLOAD_LIMITS
      ],
    ).toBe(value);
  });

  test.each([
    ["maxDepth", undefined],
    ["maxDepth", -1],
    ["maxDepth", 1.5],
    ["maxDepth", NaN],
    ["maxDepth", "8"],
    ["maxDepth", Infinity],
    ["maxEntries", undefined],
    ["maxEntries", -1],
    ["maxEntries", 1.5],
    ["maxEntries", NaN],
    ["maxEntries", "8"],
    ["maxEntries", Infinity],
    ["maxStringBytes", undefined],
    ["maxStringBytes", -1],
    ["maxStringBytes", 1.5],
    ["maxStringBytes", NaN],
    ["maxStringBytes", "8"],
    ["maxStringBytes", Infinity],
    ["maxTotalBytes", undefined],
    ["maxTotalBytes", -1],
    ["maxTotalBytes", 1.5],
    ["maxTotalBytes", NaN],
    ["maxTotalBytes", "8"],
    ["maxTotalBytes", Infinity],
  ])("%s = %p는 TypeError로 거부한다", (key, value) => {
    const resolve = () => resolvePayloadLimits({ [key]: value } as never);
    expect(resolve).toThrow(TypeError);
    expect(resolve).toThrow(
      new RegExp(
        `^Payload limit '${key}' must be a non-negative safe integer\\.$`,
      ),
    );
  });

  test("알 수 없는 키는 TypeError로 거부한다", () => {
    const resolve = () => resolvePayloadLimits({ maxWidgets: 1 } as never);
    expect(resolve).toThrow(TypeError);
    expect(resolve).toThrow(/^Unknown payload limit 'maxWidgets'\.$/);
  });

  test("여러 필드가 잘못됐으면 정의 순서상 먼저인 필드 문구로 던진다", () => {
    expect(() =>
      resolvePayloadLimits({ maxTotalBytes: -1, maxDepth: -1 } as never),
    ).toThrow(
      /^Payload limit 'maxDepth' must be a non-negative safe integer\.$/,
    );
  });

  test("알 수 없는 키와 잘못된 값이 함께 있으면 알 수 없는 키 문구가 우선한다", () => {
    expect(() =>
      resolvePayloadLimits({ maxWidgets: 1, maxDepth: -1 } as never),
    ).toThrow(/^Unknown payload limit 'maxWidgets'\.$/);
  });
});

describe("DEFAULT_PAYLOAD_LIMITS", () => {
  test("값과 동결 상태를 고정한다", () => {
    expect(DEFAULT_PAYLOAD_LIMITS).toEqual({
      maxDepth: 32,
      maxEntries: 10_000,
      maxStringBytes: 1_000_000,
      maxTotalBytes: 16_777_216,
    });
    expect(Object.isFrozen(DEFAULT_PAYLOAD_LIMITS)).toBe(true);
  });
});
