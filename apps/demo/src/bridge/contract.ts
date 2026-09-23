import {
  composeContracts,
  type InferBridge,
} from "@cp949/rx-bridge-electron/contract";
import { deviceContract } from "./device-contract.js";
import { relayContract } from "./relay-contract.js";

export { deviceContract, relayContract };
export const appContract = composeContracts(deviceContract, relayContract);
export type AppBridge = InferBridge<typeof appContract>;
