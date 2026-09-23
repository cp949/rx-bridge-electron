import { expect, test } from "vitest";
import { appendTerminalLine } from "../src/renderer/terminal.js";

test("keeps the newest 500 serial lines", () => {
  const retained = Array.from({ length: 501 }, (_, index) => ({
    kind: "rx" as const,
    text: `RX:${index}`,
    at: index,
  })).reduce(
    appendTerminalLine,
    [] as readonly { kind: "rx"; text: string; at: number }[],
  );
  expect(retained).toHaveLength(500);
  expect(retained[0]?.text).toBe("RX:1");
  expect(retained.at(-1)?.text).toBe("RX:500");
});
