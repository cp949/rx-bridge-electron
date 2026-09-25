import type { BridgeTransport } from "../../src/renderer/index.js";
import type {
  HandshakeManifest,
  HandshakeResponse,
  RendererRpcRequest,
  RendererStreamCommand,
  RpcErrorPayload,
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

const defaultManifest: Partial<HandshakeManifest> = {
  rpc: ["rpc:hardware/connect"],
};

/** 생성자에 넘겨 handshake manifest를 지정하는 옵션. 지정하지 않은 종류는 빈 배열이다. */
export interface FakeTransportOptions {
  readonly manifest?: Partial<HandshakeManifest>;
}

export class FakeTransport implements BridgeTransport {
  public connectCalls = 0;
  public handshake: Promise<unknown>;
  public readonly invocations: RendererRpcRequest[] = [];
  public readonly invocationResults: Deferred<RpcResponse>[] = [];
  public readonly cancellations: string[] = [];
  public readonly controls: RendererStreamCommand[] = [];
  public readonly streamListeners = new Set<(message: StreamMessage) => void>();
  public streamListenerRegistrations = 0;
  public controlHook?: (command: RendererStreamCommand) => void;

  public constructor(options?: FakeTransportOptions) {
    const manifest = options?.manifest ?? defaultManifest;
    const response: HandshakeResponse = {
      protocolVersion: 1,
      clientId: "client-1",
      manifest: {
        rpc: manifest.rpc ?? [],
        state: manifest.state ?? [],
        event: manifest.event ?? [],
      },
    };
    this.handshake = Promise.resolve(response);
  }

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

  /** `controls` 중 subscribe 명령만 타입 좁혀서 반환한다. */
  public subscribeCommands(): SubscribeCommand[] {
    return this.controls.filter(
      (command): command is SubscribeCommand => command.type === "subscribe",
    );
  }

  /** 같은 key로 온 subscribe 명령 중 nth번째의 subscriptionId를 반환한다. */
  public subscriptionIdFor(key: string, nth = 0): string {
    const matches = this.subscribeCommands().filter(
      (command) => command.key === key,
    );
    const command = matches[nth];
    if (command === undefined) {
      throw new Error(
        `Missing subscribe command for key "${key}" at index ${nth}.`,
      );
    }
    return command.subscriptionId;
  }
}

type SubscribeCommand = Extract<
  RendererStreamCommand,
  { readonly type: "subscribe" }
>;

/** `StreamMessage`에서 envelope·subscriptionId를 뺀 나머지 필드 모양. */
export type StreamMessageBody = StreamMessage extends infer Message
  ? Message extends StreamMessage
    ? Omit<Message, "protocolVersion" | "clientId" | "subscriptionId">
    : never
  : never;

/** envelope(`protocolVersion: 1`, `clientId: "client-1"`)을 고정해 StreamMessage를 만든다. */
export function streamMessage(
  subscriptionId: string,
  body: StreamMessageBody,
): StreamMessage {
  return {
    protocolVersion: 1,
    clientId: "client-1",
    subscriptionId,
    ...body,
  } as StreamMessage;
}

/** RPC 성공 응답 envelope을 만든다. */
export function rpcSuccess(
  requestId: string,
  result: { readonly connected: boolean } = { connected: true },
) {
  return {
    protocolVersion: 1 as const,
    clientId: "client-1",
    type: "success" as const,
    requestId,
    result,
  };
}

/** RPC 에러 응답 envelope을 만든다. */
export function rpcError(requestId: string, error: RpcErrorPayload) {
  return {
    protocolVersion: 1 as const,
    clientId: "client-1",
    type: "error" as const,
    requestId,
    error,
  };
}
