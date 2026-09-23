import {
  addPath,
  assertDomainName,
  assertOperationName,
  createPathTree,
  type DomainContract,
} from "./define-domain.js";
import type { PayloadLimits } from "../protocol/index.js";

export interface ComposedContract<
  Domains extends readonly DomainContract[] = readonly DomainContract[],
> {
  readonly payloadLimits?: PayloadLimits;
  readonly domains: {
    readonly [Domain in Domains[number] as Domain["name"]]: Domain;
  };
}

export interface ContractOptions {
  readonly payloadLimits: PayloadLimits;
}

export function composeContracts<
  const Domains extends readonly DomainContract[],
>(options: ContractOptions, ...domains: Domains): ComposedContract<Domains>;
export function composeContracts<
  const Domains extends readonly DomainContract[],
>(...domains: Domains): ComposedContract<Domains>;
export function composeContracts(
  ...arguments_: readonly (DomainContract | ContractOptions)[]
): ComposedContract {
  const first = arguments_[0];
  const options =
    first !== undefined && Object.hasOwn(first, "payloadLimits")
      ? (first as ContractOptions)
      : undefined;
  const domains = (
    options === undefined ? arguments_ : arguments_.slice(1)
  ) as readonly DomainContract[];
  const domainsByName: Record<string, DomainContract> = Object.create(null);
  const paths = createPathTree();

  for (const domain of domains) {
    if (
      !Object.hasOwn(domain, "name") ||
      !Object.hasOwn(domain, "definitions")
    ) {
      throw new TypeError("Contracts must be defined domains.");
    }
    if (Object.hasOwn(domainsByName, domain.name)) {
      throw new TypeError(`Duplicate domain name '${domain.name}'.`);
    }
    assertDomainName(domain.name);
    for (const category of ["rpc", "state", "event"] as const) {
      const definitions = domain.definitions[category];
      if (definitions === undefined) {
        continue;
      }
      for (const operation of Object.keys(definitions)) {
        assertOperationName(operation, `${category} operation`);
        addPath(paths, `${domain.name}/${operation}`);
      }
    }
    const copiedDefinitions: Record<string, object> = Object.create(null);
    for (const category of ["rpc", "state", "event"] as const) {
      const definitions = domain.definitions[category];
      if (definitions === undefined) {
        continue;
      }
      const copiedCategory: Record<string, unknown> = Object.create(null);
      for (const operation of Object.keys(definitions)) {
        copiedCategory[operation] = definitions[operation];
      }
      copiedDefinitions[category] = Object.freeze(copiedCategory);
    }
    domainsByName[domain.name] = Object.freeze({
      name: domain.name,
      definitions: Object.freeze(copiedDefinitions),
    });
  }

  const payloadLimits = options?.payloadLimits;
  if (payloadLimits !== undefined) {
    for (const key of ["maxDepth", "maxEntries", "maxStringBytes"] as const) {
      if (!Number.isSafeInteger(payloadLimits[key]) || payloadLimits[key] < 0) {
        throw new TypeError(
          `Payload limit '${key}' must be a non-negative safe integer.`,
        );
      }
    }
    if (
      payloadLimits.maxTotalBytes !== undefined &&
      (!Number.isSafeInteger(payloadLimits.maxTotalBytes) ||
        payloadLimits.maxTotalBytes < 0)
    ) {
      throw new TypeError(
        "Payload limit 'maxTotalBytes' must be a non-negative safe integer.",
      );
    }
  }
  return Object.freeze({
    domains: Object.freeze(domainsByName),
    ...(payloadLimits === undefined
      ? {}
      : { payloadLimits: Object.freeze({ ...payloadLimits }) }),
  });
}
