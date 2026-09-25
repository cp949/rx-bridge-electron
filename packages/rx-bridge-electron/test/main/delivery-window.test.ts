/**
 * consumer 1건의 전달 창(`DeliveryWindow`, RD-034)을 `Subscriptions`를
 * 거치지 않고 직접 검증한다. "수락 → ack 대기 → 다음 값 | terminal" 순서, State
 * 최신값 교체, Event `BoundedQueue` overflow 3정책, 선점 종료(`preempt`)의
 * 폐기 규칙, `close()` 멱등, 진단 callback 안 재진입, 대기 값 수 조회를
 * 다룬다. 이 파일은 RD-015 결정 5("구독 모듈 직접 test 없음")의 예외다 —
 * 창은 `BoundedQueue`와 같은 등급의 순수 module이라 직접 검증한다(RD-034).
 */
import { describe, expect, test, vi } from "vitest";

import {
  createEventDeliveryWindow,
  createRejectionDeliveryWindow,
  createStateDeliveryWindow,
  type DeliveryWindow,
} from "../../src/main/delivery-window.js";

describe("open과 sequence", () => {
  test("open은 subscribed(0)을 반환하고 첫 batch는 sequence 1이다", () => {
    const window = createStateDeliveryWindow();
    expect(window.open()).toEqual({ type: "subscribed", sequence: 0 });
    const result = window.accept(1);
    expect(result).toEqual({
      message: { type: "batch", sequence: 1, values: [1] },
      overflowed: false,
    });
  });
});

describe("ack 게이트", () => {
  test("inFlight 중 accept는 반환이 없다", () => {
    const window = createStateDeliveryWindow();
    window.open();
    window.accept(1);
    const result = window.accept(2);
    expect(result.message).toBeUndefined();
  });

  test("맞는 sequence로 ack하면 다음 batch를 반환한다", () => {
    const window = createEventDeliveryWindow(2, "drop-oldest");
    window.open();
    window.accept(1);
    window.accept(2);
    expect(window.ack(1)).toEqual({
      type: "batch",
      sequence: 2,
      values: [2],
    });
  });

  test("틀린 sequence의 ack는 무시된다", () => {
    const window = createStateDeliveryWindow();
    window.open();
    window.accept(1);
    expect(window.ack(99)).toBeUndefined();
    expect(window.ack(1)).toBeUndefined();
  });
});

describe("State 최신값 교체", () => {
  test("ack 대기 중 값을 여러 번 넣으면 ack 뒤 batch가 최신값이고 진단 callback은 불리지 않는다", () => {
    const onDropped = vi.fn();
    const onQueueDepth = vi.fn();
    const window = createStateDeliveryWindow({ onDropped, onQueueDepth });
    window.open();
    window.accept(1);
    window.accept(2);
    window.accept(3);
    expect(window.ack(1)).toEqual({
      type: "batch",
      sequence: 2,
      values: [3],
    });
    expect(onDropped).not.toHaveBeenCalled();
    expect(onQueueDepth).not.toHaveBeenCalled();
  });
});

describe("Event overflow 3정책", () => {
  test.each([
    ["drop-oldest", [3, 4], false],
    ["drop-newest", [2, 3], false],
    ["error", [2, 3], true],
  ] as const)(
    "%s 정책은 capacity 2에서 값 4개 중 1개를 drop하고 drain 값은 %j다",
    (policy, drained, overflowed) => {
      const onDropped = vi.fn();
      const window = createEventDeliveryWindow(2, policy, { onDropped });
      window.open();
      expect(window.accept(1)).toEqual({
        message: { type: "batch", sequence: 1, values: [1] },
        overflowed: false,
      });
      window.accept(2);
      window.accept(3);
      const fourth = window.accept(4);
      expect(fourth.overflowed).toBe(overflowed);
      expect(onDropped).toHaveBeenCalledTimes(1);
      expect(onDropped).toHaveBeenCalledWith(1);

      expect(window.ack(1)).toEqual({
        type: "batch",
        sequence: 2,
        values: [drained[0]],
      });
      expect(window.ack(2)).toEqual({
        type: "batch",
        sequence: 3,
        values: [drained[1]],
      });

      if (overflowed) {
        expect(window.ack(3)).toEqual({
          type: "error",
          sequence: 4,
          error: {
            code: "STREAM_OVERFLOW",
            message: "Event buffer capacity exceeded.",
          },
        });
      }
    },
  );
});

describe("대기 값 drain 뒤 terminal", () => {
  test.each([
    ["complete", { type: "complete" as const }],
    [
      "error",
      {
        type: "error" as const,
        error: { code: "INTERNAL", message: "boom" },
      },
    ],
  ])(
    "%s는 대기 값을 모두 보낸 뒤에 도착하고, 이후 accept·ack는 무출력이다",
    (_label, terminal) => {
      const window = createEventDeliveryWindow(2, "drop-oldest");
      window.open();
      window.accept(1);
      window.accept(2);
      const endResult = window.end(terminal);
      expect(endResult.recorded).toBe(true);
      expect(endResult.message).toBeUndefined();

      expect(window.ack(1)).toEqual({
        type: "batch",
        sequence: 2,
        values: [2],
      });
      expect(window.ack(2)).toEqual(
        terminal.type === "complete"
          ? { type: "complete", sequence: 3 }
          : { type: "error", sequence: 3, error: terminal.error },
      );

      expect(window.accept(99)).toEqual({
        message: undefined,
        overflowed: false,
      });
      expect(window.ack(3)).toBeUndefined();
      expect(window.end({ type: "complete" }).recorded).toBe(false);
    },
  );
});

describe("terminal 기록 뒤 수락 중단", () => {
  test.each([
    ["State", () => createStateDeliveryWindow()],
    ["Event", () => createEventDeliveryWindow(2, "drop-oldest")],
  ])(
    "%s는 terminal을 기록한 뒤 ack 대기 중 들어온 값을 받지 않고 ack 뒤 terminal을 반환한다",
    (_label, create) => {
      const window = create();
      window.open();
      window.accept(1);
      expect(window.end({ type: "complete" }).recorded).toBe(true);
      expect(window.accepting).toBe(false);

      expect(window.accept(2)).toEqual({
        message: undefined,
        overflowed: false,
      });
      expect(window.queuedValueCount()).toBe(0);
      expect(window.ack(1)).toEqual({ type: "complete", sequence: 2 });
    },
  );
});

describe("preempt", () => {
  test("대기 값·ack 대기·기록된 terminal을 버리고 다음 sequence로 error를 반환한 뒤 무출력이 된다", () => {
    const window = createEventDeliveryWindow(2, "drop-oldest");
    window.open();
    window.accept(1);
    window.accept(2);
    expect(window.end({ type: "complete" }).recorded).toBe(true);

    const message = window.preempt({ code: "CANCELLED", message: "aborted" });
    expect(message).toEqual({
      type: "error",
      sequence: 2,
      error: { code: "CANCELLED", message: "aborted" },
    });
    expect(window.queuedValueCount()).toBe(0);
    expect(window.closed).toBe(false);

    expect(window.accept(3)).toEqual({
      message: undefined,
      overflowed: false,
    });
    expect(window.ack(1)).toBeUndefined();
    expect(
      window.preempt({ code: "CANCELLED", message: "again" }),
    ).toBeUndefined();
  });
});

describe("close", () => {
  test("close()는 처음 호출에서만 true이고, 닫힌 뒤 모든 입력이 무출력이다", () => {
    const window = createStateDeliveryWindow();
    window.open();
    expect(window.close()).toBe(true);
    expect(window.close()).toBe(false);

    expect(window.accept(1)).toEqual({
      message: undefined,
      overflowed: false,
    });
    expect(window.ack(1)).toBeUndefined();
    expect(window.end({ type: "complete" }).recorded).toBe(false);
    expect(window.preempt({ code: "CANCELLED", message: "x" })).toBeUndefined();
  });
});

describe("진단 callback 안 재진입", () => {
  test("onDropped 안에서 preempt하면 onQueueDepth를 부르지 않고 accept는 무출력이다", () => {
    const events: string[] = [];
    let window!: DeliveryWindow;
    const onDropped = (count: number): void => {
      events.push(`dropped:${count}`);
      window.preempt({ code: "CANCELLED", message: "reentrant" });
    };
    const onQueueDepth = (depth: number): void => {
      events.push(`depth:${depth}`);
    };
    window = createEventDeliveryWindow(1, "drop-newest", {
      onDropped,
      onQueueDepth,
    });
    window.open();
    window.accept(1);
    window.accept(2);
    events.length = 0;

    const result = window.accept(3);
    expect(events).toEqual(["dropped:1"]);
    expect(result).toEqual({ message: undefined, overflowed: false });
  });

  test("onDropped 안에서 close하면 onQueueDepth를 부르지 않고 accept는 무출력이다", () => {
    const events: string[] = [];
    let window!: DeliveryWindow;
    const onDropped = (count: number): void => {
      events.push(`dropped:${count}`);
      window.close();
    };
    const onQueueDepth = (depth: number): void => {
      events.push(`depth:${depth}`);
    };
    window = createEventDeliveryWindow(1, "drop-newest", {
      onDropped,
      onQueueDepth,
    });
    window.open();
    window.accept(1);
    window.accept(2);
    events.length = 0;

    const result = window.accept(3);
    expect(events).toEqual(["dropped:1"]);
    expect(result).toEqual({ message: undefined, overflowed: false });
    expect(window.closed).toBe(true);
  });

  test("shift 뒤 onQueueDepth 안에서 preempt하면 batch를 반환하지 않는다", () => {
    let armed = false;
    let window!: DeliveryWindow;
    const onQueueDepth = (): void => {
      if (!armed) return;
      armed = false;
      window.preempt({ code: "CANCELLED", message: "reentrant" });
    };
    window = createEventDeliveryWindow(2, "drop-oldest", { onQueueDepth });
    window.open();
    window.accept(1);
    window.accept(2);
    armed = true;

    expect(window.ack(1)).toBeUndefined();
    expect(window.closed).toBe(false);
  });

  test("onQueueDepth 안에서 close하면 accept는 무출력이다", () => {
    let armed = false;
    let window!: DeliveryWindow;
    const onQueueDepth = (): void => {
      if (!armed) return;
      armed = false;
      window.close();
    };
    window = createEventDeliveryWindow(2, "drop-oldest", { onQueueDepth });
    window.open();
    window.accept(1);
    armed = true;

    expect(window.accept(2)).toEqual({
      message: undefined,
      overflowed: false,
    });
    expect(window.closed).toBe(true);
  });
});

describe("시작 전 거부 창", () => {
  test("open은 subscribed(0), preempt는 error(1)를 반환하고 buffer는 채워지지 않는다", () => {
    const window = createRejectionDeliveryWindow();
    expect(window.open()).toEqual({ type: "subscribed", sequence: 0 });
    expect(window.queuedValueCount()).toBe(0);

    const error = { code: "FORBIDDEN", message: "sender unauthorized" };
    expect(window.preempt(error)).toEqual({
      type: "error",
      sequence: 1,
      error,
    });
    expect(window.queuedValueCount()).toBe(0);
  });

  test.each([
    ["accept", (window: DeliveryWindow) => window.accept(1)],
    ["ack", (window: DeliveryWindow) => window.ack(1)],
    ["end", (window: DeliveryWindow) => window.end({ type: "complete" })],
    [
      "preempt",
      (window: DeliveryWindow) =>
        window.preempt({ code: "CANCELLED", message: "again" }),
    ],
  ] as const)("open과 preempt 뒤 %s는 무출력이다", (_label, call) => {
    const window = createRejectionDeliveryWindow();
    window.open();
    window.preempt({ code: "FORBIDDEN", message: "sender unauthorized" });

    expect(call(window)).toEqual(
      _label === "accept"
        ? { message: undefined, overflowed: false }
        : _label === "end"
          ? { recorded: false, message: undefined }
          : undefined,
    );
    expect(window.queuedValueCount()).toBe(0);
  });
});

describe("대기 값 수 조회", () => {
  test("Event는 buffer depth를, State는 항상 0을 돌려준다", () => {
    const eventWindow = createEventDeliveryWindow(2, "drop-oldest");
    eventWindow.open();
    eventWindow.accept(1);
    expect(eventWindow.queuedValueCount()).toBe(0);
    eventWindow.accept(2);
    expect(eventWindow.queuedValueCount()).toBe(1);

    const stateWindow = createStateDeliveryWindow();
    stateWindow.open();
    stateWindow.accept(1);
    stateWindow.accept(2);
    expect(stateWindow.queuedValueCount()).toBe(0);
  });
});
