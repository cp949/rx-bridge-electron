import { useCallback, useSyncExternalStore } from "react";

import type {
  RemoteState,
  RemoteStateSnapshot,
} from "@cp949/rx-bridge-electron/renderer";

/** Converts a bridge State stream into React's external-store contract. */
export function useRemoteState<T>(
  state: RemoteState<T>,
): RemoteStateSnapshot<T> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = state.subscribe({
        next: onStoreChange,
        error: onStoreChange,
        complete: onStoreChange,
      });
      return () => subscription.unsubscribe();
    },
    [state],
  );
  return useSyncExternalStore(
    subscribe,
    () => state.snapshot,
    () => state.snapshot,
  );
}
