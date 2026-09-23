import type { ComposedContract } from "./compose-contracts.js";

export interface PublicManifest {
  readonly rpc: readonly string[];
  readonly state: readonly string[];
  readonly event: readonly string[];
}

export function publicManifest(contract: ComposedContract): PublicManifest {
  const manifest: { rpc: string[]; state: string[]; event: string[] } = {
    rpc: [],
    state: [],
    event: [],
  };
  for (const domainName of Object.keys(contract.domains).sort()) {
    const domain = contract.domains[domainName];
    if (domain === undefined) {
      continue;
    }
    for (const category of ["rpc", "state", "event"] as const) {
      const definitions = domain.definitions[category];
      if (definitions === undefined) {
        continue;
      }
      for (const operation of Object.keys(definitions).sort()) {
        manifest[category].push(`${category}:${domainName}/${operation}`);
      }
    }
  }
  return Object.freeze({
    rpc: Object.freeze(manifest.rpc),
    state: Object.freeze(manifest.state),
    event: Object.freeze(manifest.event),
  });
}
