import { describe, expect, test } from "vitest";
import { composeContracts } from "@cp949/rx-bridge-electron/contract";
import {
  createBridgeServer,
  type AttachedTarget,
} from "@cp949/rx-bridge-electron/main";
import type { StreamMessage } from "@cp949/rx-bridge-electron/protocol";
import {
  createNotes,
  notesContract,
  registerNotes,
} from "./fixtures/notes-domain.js";

const sender = {
  webContentsId: 1,
  frameId: 1,
  isMainFrame: true,
  origin: "app://notes",
};
const target: AttachedTarget = {
  webContentsId: 1,
  role: "editor",
  isCurrentMainFrame: (value) => value.webContentsId === 1 && value.isMainFrame,
  isAllowedOrigin: (origin) => origin === "app://notes",
  onLifecycle: () => () => undefined,
};

describe("non-hardware domain", () => {
  test("registers a notes command and current State through the same bridge", async () => {
    const notes = createNotes();
    const server = createBridgeServer(composeContracts(notesContract), [
      registerNotes(notes),
    ]);
    try {
      server.attach(target);
      const response = await server.dispatchRpc(sender, {
        protocolVersion: 1,
        clientId: "notes-client",
        requestId: "append-1",
        key: "rpc:notes/append",
        input: { text: "meeting at 10" },
      });
      expect(response).toMatchObject({ type: "success", result: true });
      const messages: StreamMessage[] = [];
      await server.controlStream(
        sender,
        {
          protocolVersion: 1,
          clientId: "notes-client",
          type: "subscribe",
          subscriptionId: "latest-1",
          key: "state:notes/latest",
        },
        (message) => messages.push(message),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "batch", values: ["meeting at 10"] }),
      );
    } finally {
      server.dispose();
      notes.dispose();
    }
  });
});
