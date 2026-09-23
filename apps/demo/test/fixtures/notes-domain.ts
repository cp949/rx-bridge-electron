import { BehaviorSubject } from "rxjs";
import type { BridgeImpl, Schema } from "@cp949/rx-bridge-electron/contract";
import { currentValueSource } from "@cp949/rx-bridge-electron/main";

export type AppendInput = {
  readonly text: string;
};

export const appendInputSchema: Schema<AppendInput> = {
  parse(value) {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      typeof (value as { text?: unknown }).text !== "string" ||
      (value as { text: string }).text.length > 80
    )
      throw new TypeError("Expected note text of at most 80 characters.");
    return { text: (value as { text: string }).text };
  },
};

export type NotesBridge = {
  notes: {
    rpc: {
      append(input: AppendInput): boolean;
    };
    state: { latest: string };
  };
};

export function createNotes() {
  const latest$ = new BehaviorSubject("");
  return {
    latest$,
    dispose: () => latest$.complete(),
  };
}

export function registerNotes(
  notes: ReturnType<typeof createNotes>,
): BridgeImpl<NotesBridge> {
  return {
    notes: {
      rpc: {
        append: (input) => {
          notes.latest$.next(input.text);
          return true;
        },
      },
      state: { latest: currentValueSource(notes.latest$) },
    },
  };
}
