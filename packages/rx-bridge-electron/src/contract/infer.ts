import type { Observable } from "rxjs";

import type { ComposedContract } from "./compose-contracts.js";
import type { DomainContract } from "./define-domain.js";
import type {
  EventDescriptor,
  RpcDescriptor,
  StateDescriptor,
} from "./descriptors.js";

export type RemoteStateSnapshot<T> =
  | { readonly status: "uninitialized"; readonly active: false }
  | { readonly status: "connecting"; readonly active: true }
  | { readonly status: "current"; readonly active: true; readonly value: T }
  | { readonly status: "stale"; readonly active: false; readonly value: T };

export interface RemoteState<T> extends Observable<T> {
  readonly snapshot: RemoteStateSnapshot<T>;
}

type InferRpc<Descriptor> =
  Descriptor extends RpcDescriptor<infer I, infer O, string>
    ? [I] extends [undefined]
      ? () => Promise<O>
      : (input: I) => Promise<O>
    : never;

type InferState<Descriptor> =
  Descriptor extends StateDescriptor<infer T> ? RemoteState<T> : never;

type InferEvent<Descriptor> =
  Descriptor extends EventDescriptor<infer T> ? Observable<T> : never;

type InferCategory<Category extends string, Entries, Leaf> = [
  keyof Entries,
] extends [never]
  ? unknown
  : { readonly [Key in Category]: Leaf };

type InferDefinitions<Definitions> = (Definitions extends {
  readonly rpc: infer Rpc;
}
  ? InferCategory<
      "rpc",
      Rpc,
      { readonly [Key in keyof Rpc]: InferRpc<Rpc[Key]> }
    >
  : unknown) &
  (Definitions extends { readonly state: infer State }
    ? InferCategory<
        "state",
        State,
        { readonly [Key in keyof State]: InferState<State[Key]> }
      >
    : unknown) &
  (Definitions extends { readonly event: infer Event }
    ? InferCategory<
        "event",
        Event,
        { readonly [Key in keyof Event]: InferEvent<Event[Key]> }
      >
    : unknown);

type UnionToIntersection<Value> = (
  Value extends unknown ? (argument: Value) => void : never
) extends (argument: infer Result) => void
  ? Result
  : never;

type SetPath<
  Path extends string,
  Value,
> = Path extends `${infer Head}/${infer Tail}`
  ? { readonly [Key in Head]: SetPath<Tail, Value> }
  : { readonly [Key in Path]: Value };

type InferDomain<Domain> =
  Domain extends DomainContract<infer Name, infer Definitions>
    ? SetPath<Name, InferDefinitions<Definitions>>
    : never;

export type InferBridge<Contract> =
  Contract extends ComposedContract<infer Domains>
    ? UnionToIntersection<InferDomain<Domains[number]>>
    : never;
