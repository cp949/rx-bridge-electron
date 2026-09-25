import { useSyncExternalStore } from "react";

import {
  snapshotStore,
  type RemoteState,
  type RemoteStateSnapshot,
} from "@cp949/rx-bridge-electron/renderer";

/** Converts a bridge State stream into React's external-store contract. */
export function useRemoteState<T>(
  state: RemoteState<T>,
): RemoteStateSnapshot<T> {
  const store = snapshotStore(state);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
