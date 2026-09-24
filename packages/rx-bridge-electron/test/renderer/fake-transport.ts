import type { BridgeTransport } from "../../src/renderer/index.js";
import type {
  HandshakeResponse,
  RendererRpcRequest,
  RendererStreamCommand,
  RpcResponse,
  StreamMessage,
} from "../../src/protocol/index.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

type OptionalRequestId<Response> = Response extends {
  readonly requestId: string;
}
  ? Omit<Response, "requestId"> & { readonly requestId?: string }
  : never;

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const defaultHandshake: HandshakeResponse = {
  protocolVersion: 1,
  clientId: "client-1",
  manifest: {
    rpc: ["rpc:hardware/connect"],
    state: [],
    event: [],
  },
};

export class FakeTransport implements BridgeTransport {
  public connectCalls = 0;
  public handshake: Promise<unknown> = Promise.resolve(defaultHandshake);
  public readonly invocations: RendererRpcRequest[] = [];
  public readonly invocationResults: Deferred<RpcResponse>[] = [];
  public readonly cancellations: string[] = [];
  public readonly controls: RendererStreamCommand[] = [];
  public readonly streamListeners = new Set<(message: StreamMessage) => void>();
  public streamListenerRegistrations = 0;
  public controlHook?: (command: RendererStreamCommand) => void;

  public connect(): Promise<never> {
    this.connectCalls += 1;
    return this.handshake as Promise<never>;
  }

  public invoke(request: RendererRpcRequest): Promise<RpcResponse> {
    this.invocations.push(request);
    const result = deferred<RpcResponse>();
    this.invocationResults.push(result);
    return result.promise;
  }

  public cancel(requestId: string): void {
    this.cancellations.push(requestId);
  }

  public control(command: RendererStreamCommand): void {
    this.controls.push(command);
    this.controlHook?.(command);
  }

  public onStreamMessage(
    listener: (message: StreamMessage) => void,
  ): () => void {
    this.streamListenerRegistrations += 1;
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  public emitStream(message: StreamMessage): void {
    for (const listener of this.streamListeners) {
      listener(message);
    }
  }

  public resolveInvocation(
    index: number,
    response: OptionalRequestId<RpcResponse>,
  ): void {
    const invocation = this.invocations[index];
    const result = this.invocationResults[index];
    if (invocation === undefined || result === undefined) {
      throw new Error(`Missing invocation at index ${index}.`);
    }
    result.resolve({
      ...response,
      requestId: response.requestId ?? invocation.requestId,
    } as RpcResponse);
  }
}
