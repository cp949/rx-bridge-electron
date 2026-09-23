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

/**
 * value가 plain object이고 열거 가능한 data property만 갖는지 검증한다.
 * `defineDomain`(definitions 객체)과 경량 계약 impl 트리 검증
 * (`main/registration.ts`의 `buildRegistrationTableFromImpl`, DELTA-04)이
 * 함께 쓴다 — 두 경로 모두 "사용자가 만든 중첩 객체가 안전한 plain object인가"를
 * 같은 기준으로 검사해야 하므로 위치를 이곳(계약 계층)으로 공유한다.
 */
export function assertOwnDataRecord(
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

const categorySegments = new Set(["rpc", "state", "event"]);

export function assertDomainName(name: string): void {
  const segments = assertPathSegments(name, "Domain name");
  if (segments[0] === "dispose") {
    throw new TypeError("Domain name contains reserved segment 'dispose'.");
  }
  for (const segment of segments) {
    if (categorySegments.has(segment)) {
      throw new TypeError(
        `Domain name contains reserved segment '${segment}'.`,
      );
    }
  }
}

export function assertOperationName(name: string, label: string): void {
  if (assertPathSegments(name, label).length !== 1) {
    throw new TypeError(`${label} '${name}' cannot be a nested path.`);
  }
}

/**
 * "domain/operation" 전체 경로들을 하나의 trie에 누적하며 leaf/namespace
 * 충돌과 중복 경로를 검출한다. `composeContracts`(여러 도메인의 선언 경로)와
 * `buildRegistrationTableFromImpl`(경량 계약 impl 트리의 등록 경로, DELTA-04)이
 * 같은 검사 기준을 공유하도록 이곳(계약 계층)에 둔다.
 */
export interface PathNode {
  leaf: boolean;
  readonly children: Map<string, PathNode>;
}

export function createPathTree(): PathNode {
  return { leaf: false, children: new Map() };
}

export function addPath(root: PathNode, path: string): void {
  const segments = assertPathSegments(path, "Operation path");
  let node = root;
  for (const segment of segments) {
    if (node.leaf) {
      throw new TypeError(`Leaf/namespace collision at '${path}'.`);
    }
    let child = node.children.get(segment);
    if (child === undefined) {
      child = { leaf: false, children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.leaf || node.children.size > 0) {
    throw new TypeError(
      `Duplicate path or leaf/namespace collision at '${path}'.`,
    );
  }
  node.leaf = true;
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
    assertOperationName(name, `${category} operation`);
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
