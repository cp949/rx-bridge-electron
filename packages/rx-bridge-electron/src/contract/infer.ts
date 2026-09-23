import type { Observable } from "rxjs";

export type RemoteStateSnapshot<T> =
  | { readonly status: "uninitialized"; readonly active: false }
  | { readonly status: "connecting"; readonly active: true }
  | { readonly status: "current"; readonly active: true; readonly value: T }
  | { readonly status: "stale"; readonly active: false; readonly value: T };

export interface RemoteState<T> extends Observable<T> {
  readonly snapshot: RemoteStateSnapshot<T>;
}
