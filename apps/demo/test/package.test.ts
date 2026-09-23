import demoPackage from "../package.json" with { type: "json" };
import { expect, test } from "vitest";

test("declares the built Electron Main entry", () => {
  expect((demoPackage as { readonly main?: unknown }).main).toBe(
    "out/main/index.js",
  );
});
