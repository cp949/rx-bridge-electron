import { firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";
import { createBridgeServer } from "@cp949/rx-bridge-electron/main";
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
import { createLoopbackTransport } from "@cp949/rx-bridge-electron/testing";
import type { SchemasFor } from "@cp949/rx-bridge-electron/contract";
import {
  appendInputSchema,
  createNotes,
  registerNotes,
  type NotesBridge,
} from "./fixtures/notes-domain.js";

const schemas = {
  notes: { rpc: { append: { input: appendInputSchema } } },
} satisfies SchemasFor<NotesBridge>;

describe("non-hardware domain", () => {
  test("registers a notes command and current State through the same bridge", async () => {
    const notes = createNotes();
    const server = createBridgeServer(registerNotes(notes), { schemas });
    const transport = createLoopbackTransport(server, { role: "editor" });
    const api = await createRendererApi<NotesBridge>({ transport });
    try {
      await expect(
        api.notes.rpc.append({ text: "meeting at 10" }),
      ).resolves.toBe(true);

      const latest = await firstValueFrom(api.notes.state.latest);
      expect(latest).toBe("meeting at 10");
    } finally {
      api.dispose();
      transport.dispose();
      server.dispose();
      notes.dispose();
    }
  });
});
