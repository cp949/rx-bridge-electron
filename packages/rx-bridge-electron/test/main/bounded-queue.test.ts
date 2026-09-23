import { describe, expect, test } from "vitest";

import { BoundedQueue } from "../../src/main/bounded-queue.js";

describe("bounded Event queue", () => {
  test.each([
    ["drop-oldest", [2, 3], false],
    ["drop-newest", [1, 2], false],
    ["error", [1, 2], true],
  ] as const)(
    "%s keeps capacity while overflow is withheld",
    (policy, values, overflow) => {
      const queue = new BoundedQueue<number>(2, policy);
      queue.push(1);
      queue.push(2);
      const result = queue.push(3);
      expect(queue.length).toBe(2);
      expect(queue.drain()).toEqual(values);
      expect(result.overflow).toBe(overflow);
      expect(result.dropped).toBe(1);
    },
  );

  test("wraps a fixed ring without changing order", () => {
    const queue = new BoundedQueue<number>(2, "drop-oldest");
    queue.push(1);
    queue.push(2);
    expect(queue.shift()).toBe(1);
    queue.push(3);
    expect(queue.drain()).toEqual([2, 3]);
    expect(queue.length).toBe(0);
  });
});
