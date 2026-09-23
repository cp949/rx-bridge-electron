import { contextBridge, ipcRenderer } from "electron";

import { exposeBridgeInMainWorld } from "@cp949/rx-bridge-electron/preload";

exposeBridgeInMainWorld({
  contextBridge,
  ipcRenderer,
  namespace: "demo",
  globalName: "appBridge",
});
