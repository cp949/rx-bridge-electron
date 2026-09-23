import type { SerialLine } from "../bridge/device-contract.js";
export const MAX_TERMINAL_LINES = 500;
export function appendTerminalLine(
  lines: readonly SerialLine[],
  line: SerialLine,
): readonly SerialLine[] {
  const next = [...lines, line];
  return next.length <= MAX_TERMINAL_LINES
    ? next
    : next.slice(-MAX_TERMINAL_LINES);
}
