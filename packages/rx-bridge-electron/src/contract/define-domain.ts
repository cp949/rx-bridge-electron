import type {
  EventDescriptor,
  RpcDescriptor,
  StateDescriptor,
} from "./descriptors.js";
import type { BridgeValue } from "../protocol/index.js";

export interface DomainDefinitions {
  readonly rpc?: Readonly<
    Record<string, RpcDescriptor<BridgeValue, BridgeValue, string>>
  >;
  readonly state?: Readonly<Record<string, StateDescriptor<BridgeValue>>>;
  readonly event?: Readonly<Record<string, EventDescriptor<BridgeValue>>>;
}

export interface DomainContract<
  Name extends string = string,
  Definitions extends DomainDefinitions = DomainDefinitions,
> {
  readonly name: Name;
  readonly definitions: Definitions;
}

const reservedSegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

function assertOwnDataRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol keys.`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      property === undefined ||
      !("value" in property) ||
      !property.enumerable
    ) {
      throw new TypeError(
        `${label} must contain enumerable data properties only.`,
      );
    }
  }
}

export function assertPathSegments(
  path: string,
  label: string,
): readonly string[] {
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new TypeError(`${label} cannot contain an empty segment.`);
    }
    if (segment.includes(".")) {
      throw new TypeError(`${label} cannot contain dotted segments.`);
    }
    if (reservedSegments.has(segment)) {
      throw new TypeError(`${label} contains reserved segment '${segment}'.`);
    }
  }
  return segments;
}

export function assertDomainName(name: string): void {
  if (assertPathSegments(name, "Domain name")[0] === "dispose") {
    throw new TypeError("Domain name contains reserved segment 'dispose'.");
  }
}

function assertDescriptors(
  definitions: Record<string, unknown>,
  category: "rpc" | "state" | "event",
): void {
  const entries = definitions[category];
  if (entries === undefined) {
    return;
  }
  assertOwnDataRecord(entries, `${category} definitions`);
  for (const name of Object.keys(entries)) {
    assertPathSegments(name, `${category} operation`);
    const descriptor = entries[name];
    if (
      descriptor === null ||
      typeof descriptor !== "object" ||
      !Object.hasOwn(descriptor, "kind") ||
      (descriptor as { kind?: unknown }).kind !== category
    ) {
      throw new TypeError(
        `${category} operation '${name}' has an invalid descriptor.`,
      );
    }
  }
}

export function defineDomain<
  Name extends string,
  Definitions extends DomainDefinitions,
>(name: Name, definitions: Definitions): DomainContract<Name, Definitions> {
  assertDomainName(name);
  assertOwnDataRecord(definitions, "Domain definitions");
  for (const key of Object.keys(definitions)) {
    if (key !== "rpc" && key !== "state" && key !== "event") {
      throw new TypeError(`Unknown domain definition category '${key}'.`);
    }
  }
  assertDescriptors(definitions, "rpc");
  assertDescriptors(definitions, "state");
  assertDescriptors(definitions, "event");
  const operationPaths = new Set<string>();
  for (const category of ["rpc", "state", "event"] as const) {
    const entries = definitions[category];
    if (entries === undefined) {
      continue;
    }
    for (const operation of Object.keys(entries)) {
      if (operationPaths.has(operation)) {
        throw new TypeError(`Duplicate operation path '${operation}'.`);
      }
      operationPaths.add(operation);
    }
  }
  return Object.freeze({ name, definitions });
}
