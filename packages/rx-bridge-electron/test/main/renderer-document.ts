/**
 * Main stream test용 가짜 Renderer 문서 1개(sender 식별자 + clientId).
 *
 * server seam(`StreamBridgeServer.controlStream`) 위에서 Renderer가 보내는
 * 정상 stream command(subscribe·acknowledge·unsubscribe)의 wire 조립을 맡는다.
 * subscriptionId 발급(watermark 순서), 구독별 수신 frame 기록, ack sequence
 * 기본값을 이 module이 알고, test는 행동만 적는다.
 *
 * server 생성·`FakeTarget` attach·수명 사건·`dispose`는 test가 직접 다룬다.
 * 비정상 envelope·잘못된 subscriptionId·handshake·RPC는 raw `server.*` 호출로
 * 적는다 — 이 module은 정상 Renderer 동작만 흉내 낸다.
 */
import type {
  SenderIdentity,
  StreamBridgeServer,
} from "../../src/main/index.js";
import type {
  StreamMessage,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { sender as senderIdentity } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

/** 구독 handle. `frames`는 이 구독의 `send`로 받은 frame을 순서대로 담는다. */
export interface TestSubscription {
  /** wire subscriptionId(`testSubscriptionId(n)` 형식). */
  readonly id: string;
  readonly frames: StreamMessage[];
  /** subscribe 호출의 `controlStream` promise. `begin`으로 시작한 구독은 이것을 기다린다. */
  readonly ready: Promise<void>;
  /** `frames`의 `type` 목록. */
  types(): StreamMessage["type"][];
  /** `sequence`를 생략하면 마지막으로 받은 frame의 sequence로 ack한다. */
  ack(sequence?: number): Promise<void>;
  unsubscribe(): Promise<void>;
}

export interface SubscribeOptions {
  /**
   * subscriptionId 번호를 직접 정한다(같은 id 재전송·낮은 id 등 watermark
   * 사례). 생략하면 server 단위 카운터가 다음 번호를 발급한다.
   */
  readonly id?: number;
  /**
   * frame을 `frames`에 기록한 직후 호출된다. throw하면 server의 `send`가
   * throw한 것과 같다. 안에서 `subscription.ack()`·`unsubscribe()`를 부르면
   * 재진입 command가 된다.
   */
  readonly onFrame?: (
    frame: StreamMessage,
    subscription: TestSubscription,
  ) => void;
}

export interface RendererDocument {
  readonly sender: SenderIdentity;
  readonly clientId: string;
  /** subscribe를 보내고 `ready`를 기다리지 않은 handle을 즉시 돌려준다(authorize 대기 등). */
  begin(key: string, options?: SubscribeOptions): TestSubscription;
  /** subscribe를 보내고 `ready`가 끝난 handle을 돌려준다. */
  subscribe(key: string, options?: SubscribeOptions): Promise<TestSubscription>;
}

export interface RendererDocumentOptions extends Partial<SenderIdentity> {
  readonly clientId?: string;
}

/**
 * server마다 다음 subscriptionId 번호. 기존 test는 두 문서가 번호를 이어서
 * 쓴다(문서 1이 1, 문서 2가 2) — 문서 단위로 1부터 세면 wire가 달라진다.
 */
const nextIds = new WeakMap<StreamBridgeServer, number>();

/** 다음 번호를 정한다. 명시 번호를 쓰면 카운터를 그 뒤로 전진시킨다. */
function issueId(server: StreamBridgeServer, explicit?: number): number {
  const next = nextIds.get(server) ?? 1;
  const n = explicit ?? next;
  nextIds.set(server, Math.max(next, n + 1));
  return n;
}

/** `server` 위의 Renderer 문서 1개. 기본값은 `sender()`·`clientId: "client-1"`. */
export function rendererDocument(
  server: StreamBridgeServer,
  options: RendererDocumentOptions = {},
): RendererDocument {
  const { clientId = "client-1", ...identity } = options;
  const sender = senderIdentity(identity);
  const control = (command: WireStreamCommand): Promise<void> =>
    // server는 subscribe 외 command에서 `send`를 쓰지 않는다.
    server.controlStream(sender, command, () => {});

  const begin = (
    key: string,
    subscribeOptions: SubscribeOptions = {},
  ): TestSubscription => {
    const id = testSubscriptionId(issueId(server, subscribeOptions.id));
    const frames: StreamMessage[] = [];
    let ready!: Promise<void>;
    const subscription: TestSubscription = {
      id,
      frames,
      get ready() {
        return ready;
      },
      types: () => frames.map((frame) => frame.type),
      ack: (sequence) => {
        const last = frames.at(-1);
        if (sequence === undefined && last === undefined)
          throw new Error(`${id}: ack할 frame이 없다`);
        return control({
          protocolVersion: 1,
          clientId,
          type: "acknowledge",
          subscriptionId: id,
          sequence: sequence ?? last!.sequence,
        });
      },
      unsubscribe: () =>
        control({
          protocolVersion: 1,
          clientId,
          type: "unsubscribe",
          subscriptionId: id,
        }),
    };
    ready = server.controlStream(
      sender,
      {
        protocolVersion: 1,
        clientId,
        type: "subscribe",
        subscriptionId: id,
        key,
      },
      (frame) => {
        frames.push(frame);
        subscribeOptions.onFrame?.(frame, subscription);
      },
    );
    return subscription;
  };

  return {
    sender,
    clientId,
    begin,
    subscribe: async (key, subscribeOptions) => {
      const subscription = begin(key, subscribeOptions);
      await subscription.ready;
      return subscription;
    },
  };
}
