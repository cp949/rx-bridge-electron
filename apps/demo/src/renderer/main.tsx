import { createRoot } from "react-dom/client";
import type { AppBridge } from "../bridge/contract.js";
import { MainMonitorApp, SensorMonitorApp } from "./App.js";
import { createRendererApi } from "@cp949/rx-bridge-electron/renderer";
const api = await createRendererApi<AppBridge>();
const role = new URLSearchParams(window.location.search).get("role");
createRoot(document.getElementById("root")!).render(
  role === "monitor" ? (
    <SensorMonitorApp api={api} />
  ) : (
    <MainMonitorApp api={api} />
  ),
);
