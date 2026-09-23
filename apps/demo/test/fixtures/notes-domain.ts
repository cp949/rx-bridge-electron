import { BehaviorSubject } from "rxjs";
import {
  defineDomain,
  rpc,
  state,
  type Schema,
} from "@cp949/rx-bridge-electron/contract";
import {
  currentValueSource,
  implementDomain,
} from "@cp949/rx-bridge-electron/main";
import type { BridgeValue } from "@cp949/rx-bridge-electron/protocol";

interface AppendInput extends Record<string, BridgeValue> {
  readonly text: string;
}

const appendInput: Schema<AppendInput> = {
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
const saved: Schema<boolean> = {
  parse(value) {
    if (value !== true) throw new TypeError("Expected saved confirmation.");
    return true;
  },
};
const noteText: Schema<string> = {
  parse(value) {
    if (typeof value !== "string") throw new TypeError("Expected note text.");
    return value;
  },
};

export const notesContract = defineDomain("notes", {
  rpc: { append: rpc({ input: appendInput, output: saved }) },
  state: { latest: state(noteText) },
});

export function createNotes() {
  const latest$ = new BehaviorSubject("");
  return {
    latest$,
    dispose: () => latest$.complete(),
  };
}

export function registerNotes(notes: ReturnType<typeof createNotes>) {
  return implementDomain(notesContract, {
    rpc: {
      append: (input) => {
        notes.latest$.next((input as AppendInput).text);
        return true;
      },
    },
    state: { latest: currentValueSource(notes.latest$) },
  });
}
