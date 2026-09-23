import { createRoot } from "react-dom/client";
import type { AppBridge } from "../bridge/contract.js";
import { MainMonitorApp, SensorMonitorApp } from "./App.js";
import {
  createRendererApi,
  type BridgeTransport,
} from "@cp949/rx-bridge-electron/renderer";
declare global {
  interface Window {
    readonly appBridge: BridgeTransport;
  }
}
const api = await createRendererApi<AppBridge>(window.appBridge);
const role = new URLSearchParams(window.location.search).get("role");
createRoot(document.getElementById("root")!).render(
  role === "monitor" ? (
    <SensorMonitorApp api={api} />
  ) : (
    <MainMonitorApp api={api} />
  ),
);
