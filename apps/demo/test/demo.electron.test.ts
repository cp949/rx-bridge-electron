import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { afterEach, describe, expect, test } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const electronExecutable = createRequire(import.meta.url)("electron") as string;
const unpackagedMain = fileURLToPath(
  new URL("../out/main/index.js", import.meta.url),
);
const packaged = process.env.DEMO_PACKAGED_EXECUTABLE;
async function launchDemo(): Promise<ElectronApplication> {
  return packaged
    ? electron.launch({ executablePath: packaged, args: ["--disable-gpu"] })
    : electron.launch({
        executablePath: electronExecutable,
        args: [unpackagedMain, "--disable-gpu"],
      });
}
async function windowFor(
  app: ElectronApplication,
  label: string,
): Promise<Page> {
  for (const page of await app.windows())
    if (await page.getByText(label, { exact: true }).count()) return page;
  throw new Error(`${label} window missing`);
}
const target = packaged ? "packaged" : "development";
describe(`${target} Virtual Device Monitor`, () => {
  let app: ElectronApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test("shares current State, enforces monitor role, and stops on cable disconnect", async () => {
    app = await launchDemo();
    const main = await windowFor(app, "Controller");
    const monitor = await windowFor(app, "Read-only monitor");
    await main.getByRole("button", { name: "Connect", exact: true }).click();
    await main.getByText("Connection: connected").waitFor();
    await monitor.getByText("Connection: connected").waitFor();
    await main.getByText(/RX:/).first().waitFor();
    await monitor.getByText(/RX events received: [1-9]/).waitFor();
    await monitor.getByRole("button", { name: "Try Disconnect" }).click();
    await monitor
      .getByRole("alert")
      .getByText(/FORBIDDEN/)
      .waitFor();
    await main.getByText("Connection: connected").waitFor();
    await main.getByRole("textbox", { name: "Command" }).fill("AT+STATUS");
    await main.getByRole("button", { name: "Send", exact: true }).click();
    await main.getByText("OK AT+STATUS").waitFor();
    await main.getByRole("button", { name: "Trigger Error" }).click();
    await main.getByText("DEVICE_TIMEOUT: Device response timeout").waitFor();
    await main
      .getByRole("button", { name: "Simulate Cable Disconnect" })
      .click();
    await main.getByText("Reason: cable-disconnected").waitFor();
    await monitor.getByText("Connection: disconnected").waitFor();
    const before = await main.getByText(/Packets generated:/).textContent();
    await main.waitForTimeout(150);
    expect(await main.getByText(/Packets generated:/).textContent()).toBe(
      before,
    );
    await monitor.close();
    await main.getByText("Reason: cable-disconnected").waitFor();
    await main.close();
    await app.waitForEvent("close");
  });

  test("operates the relay in the controller and keeps the monitor read-only", async () => {
    app = await launchDemo();
    const main = await windowFor(app, "Controller");
    const monitor = await windowFor(app, "Read-only monitor");
    await main.getByText("Relay: off").waitFor();
    await monitor.getByText("Relay: off").waitFor();
    await main.getByRole("button", { name: "Relay On" }).click();
    await main.getByText("Relay: on").waitFor();
    await monitor.getByText("Relay: on").waitFor();
    await monitor.getByRole("button", { name: "Try Relay Off" }).click();
    await monitor
      .getByRole("alert")
      .getByText(/FORBIDDEN/)
      .waitFor();
    await main.getByText("Relay: on").waitFor();
    await main.getByRole("button", { name: "Simulate Relay Fault" }).click();
    await main.getByText("Relay: faulted").waitFor();
    await monitor.getByText("Relay: faulted").waitFor();
    await main.getByText("RELAY_TRIPPED: Relay overload simulated.").waitFor();
    await main.getByRole("button", { name: "Reset Relay" }).click();
    await main.getByText("Relay: off").waitFor();
  });

  test("keeps the renderer isolated from Node and raw Electron", async () => {
    app = await launchDemo();
    const main = await windowFor(app, "Controller");
    const exposed = await main.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      bridge: Object.keys(window.appBridge),
    }));
    expect(exposed.require).toBe("undefined");
    expect(exposed.process).toBe("undefined");
    expect(exposed.bridge).toEqual([
      "connect",
      "invoke",
      "cancel",
      "control",
      "onStreamMessage",
    ]);
  });

  test("keeps active Main telemetry after closing the monitor and samples its display", async () => {
    app = await launchDemo();
    const main = await windowFor(app, "Controller");
    const monitor = await windowFor(app, "Read-only monitor");
    await main.getByRole("button", { name: "Connect", exact: true }).click();
    await main.getByText("Connection: connected").waitFor();
    await main
      .getByRole("combobox", { name: "Source rate" })
      .selectOption("1000");
    await main.getByText(/Packets generated: [1-9]/).waitFor();
    await monitor.close();
    const before = Number(
      (await main.getByText(/Packets generated:/).textContent())?.match(
        /\d+/,
      )?.[0],
    );
    await main.waitForFunction((previous) => {
      const line = [...document.querySelectorAll("p")].find((element) =>
        element.textContent?.startsWith("Packets generated:"),
      );
      return Number(line?.textContent?.match(/\d+/)?.[0]) > previous;
    }, before);
    const generated = Number(
      (await main.getByText(/Packets generated:/).textContent())?.match(
        /\d+/,
      )?.[0],
    );
    const rendered = Number(
      (
        await main
          .getByText(/UI rendered samples:/)
          .first()
          .textContent()
      )?.match(/\d+/)?.[0],
    );
    expect(generated).toBeGreaterThan(rendered * 5);
    await main.close();
    await app.waitForEvent("close");
  });
});
