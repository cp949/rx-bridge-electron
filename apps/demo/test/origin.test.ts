import { expect, test } from "vitest";

import { originOf } from "../src/main/origin.js";

test("keeps an opaque app protocol host in its authorization origin", () => {
  expect(originOf("app://trusted/index.html")).toBe("app://trusted");
  expect(originOf("app://evil/index.html")).toBe("app://evil");
});
