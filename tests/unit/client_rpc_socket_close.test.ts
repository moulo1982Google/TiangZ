import { expect, test, vi } from "vitest";
import {
  ClientConnectionClosedError,
  ClientInboundOverflowError,
  ClientRpcTimeoutError,
} from "../../client_sdk/typescript/Core/Net/ClientError";
import {
  type ClientEndpoint,
  type ClientTransport,
  type ClientTransportListener,
  registerClientTransport,
} from "../../client_sdk/typescript/Core/Net/ClientTransport";
import { RpcSocket, type RpcSocketOptions } from "../../client_sdk/typescript/Core/Net/RpcSocket";
import { BinaryReader, BinaryWriter } from "../../client_sdk/typescript/Core/Protocol/Binary";
import { packFrame } from "../../client_sdk/typescript/Core/Protocol/Frame";
import { type Codec, type IResponse, defineMessage } from "../../client_sdk/typescript/Core/Protocol/Message";
import { defineRpc } from "../../client_sdk/typescript/Core/Protocol/Rpc";

// 请求、回复和推送共用一个最小 codec：text=1、rpcId=90、error=91。 / One minimal codec for requests, replies and pushes.
interface Echo extends IResponse { text?: string }
const codec: Codec<Echo> = {
  encode(value) {
    const writer = new BinaryWriter();
    writer.string(1, value.text);
    writer.uint32(90, value.rpcId);
    writer.uint32(91, value.error);
    return writer.finish();
  },
  decode(payload) {
    const reader = new BinaryReader(payload);
    const value: Echo = {};
    while (!reader.eof()) {
      const tag = reader.tag();
      if (tag.fieldNo === 1) value.text = reader.string();
      else if (tag.fieldNo === 90) value.rpcId = reader.uint32();
      else if (tag.fieldNo === 91) value.error = reader.uint32();
      else reader.skip(tag.wireType);
    }
    return value;
  },
};
const EchoRpc = defineRpc<Echo, Echo>({ name: "Echo", requestCode: 1, responseCode: 2, requestCodec: codec, responseCodec: codec });
const Notice = defineMessage<Echo>({ name: "Notice", msgcode: 3, codec });

/** 与真实传输相同：帧只经 onMessage 入队，远端关闭在已到达的帧之后通知。 / Like real transports: frames arrive before the close notice. */
class FakeTransport implements ClientTransport {
  connected = false;
  readonly sent: Echo[] = [];
  private listener?: ClientTransportListener;
  constructor(readonly endpoint: ClientEndpoint) {}
  setListener(listener: ClientTransportListener): void { this.listener = listener; }
  async connect(): Promise<void> { this.connected = true; }
  send(frame: Uint8Array): void { this.sent.push(codec.decode(frame.subarray(2))); }
  close(): void { this.connected = false; }
  reply(index: number, text: string): void {
    this.listener!.onMessage(packFrame(EchoRpc.responseCode, codec.encode({ rpcId: this.sent[index]!.rpcId, text })));
  }
  push(text: string): void { this.listener!.onMessage(packFrame(Notice.msgcode, codec.encode({ text }))); }
  serverClose(): void {
    this.connected = false;
    this.listener!.onClose(new Error("server closed"));
  }
}

const transports: FakeTransport[] = [];
registerClientTransport("websocket", (endpoint) => {
  const transport = new FakeTransport(endpoint);
  transports.push(transport);
  return transport;
});

function open(options: RpcSocketOptions = {}): { socket: RpcSocket; transport: FakeTransport } {
  const socket = new RpcSocket({ transport: "websocket", host: "127.0.0.1", port: 7000 }, options);
  return { socket, transport: transports[transports.length - 1]! };
}

interface Settled<T> { status: "pending" | "fulfilled" | "rejected"; value?: T; error?: unknown }
function settle<T>(promise: Promise<T>): Settled<T> {
  const state: Settled<T> = { status: "pending" };
  promise.then(
    (value) => { state.status = "fulfilled"; state.value = value; },
    (error: unknown) => { state.status = "rejected"; state.error = error; },
  );
  return state;
}

/** 只推进微任务，假计时器下也可用。 / Drains microtasks only, so it also works under fake timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function sent(transport: FakeTransport, count: number): Promise<void> {
  await flush();
  expect(transport.sent.length).toBe(count);
}

test("a reply queued in the same batch as the remote close is delivered by update()", async () => {
  const states: string[] = [];
  const { socket, transport } = open({ onStateChange: (state) => states.push(state) });
  const call = settle(socket.call(EchoRpc, { text: "reconnect" }));
  await sent(transport, 1);

  transport.reply(0, "token-2");
  transport.serverClose();
  await flush();
  expect(socket.state).toBe("closed");
  expect(call.status).toBe("pending");

  expect(socket.update()).toBe(1);
  await flush();
  expect(call.status).toBe("fulfilled");
  expect(call.value?.text).toBe("token-2");
  expect(states).toEqual(["connecting", "connected", "closed"]);
});

test("a reply queued a frame before the remote close is still delivered", async () => {
  const { socket, transport } = open();
  const call = settle(socket.call(EchoRpc, { text: "reconnect" }));
  await sent(transport, 1);

  transport.reply(0, "token-2");
  await new Promise((resolve) => setTimeout(resolve, 0));
  transport.serverClose();
  socket.update();
  await flush();
  expect(call.value?.text).toBe("token-2");
});

test("calls without a queued reply fail at once; pushes and replies keep arrival order", async () => {
  const seen: string[] = [];
  const { socket, transport } = open();
  socket.on(Notice, (message) => seen.push(`notice:${message.text}`));
  const answered = settle(socket.call(EchoRpc, { text: "a" }));
  const unanswered = settle(socket.call(EchoRpc, { text: "b" }));
  await sent(transport, 2);

  transport.push("before");
  transport.reply(0, "reply-a");
  transport.push("after");
  transport.serverClose();
  await flush();
  expect(unanswered.status).toBe("rejected");
  expect(unanswered.error).toBeInstanceOf(ClientConnectionClosedError);
  expect((unanswered.error as ClientConnectionClosedError).cause).toMatchObject({ message: "server closed" });
  expect(answered.status).toBe("pending");

  // 分批泵送：回复帧还在队列里时，收尾拒绝不能提前触发。 / Partial pumping must not trigger the final rejection early.
  expect(socket.update(1)).toBe(1);
  await flush();
  expect(seen).toEqual(["notice:before"]);
  expect(answered.status).toBe("pending");

  expect(socket.update()).toBe(2);
  await flush();
  expect(seen).toEqual(["notice:before", "notice:after"]);
  expect(answered.value?.text).toBe("reply-a");
  expect(socket.queuedMessages).toBe(0);
});

test("a kept call still times out when nobody pumps the queue", async () => {
  vi.useFakeTimers();
  try {
    const unhandled: Array<[number, number | undefined]> = [];
    const { socket, transport } = open({ onUnhandledMessage: (msgcode, rpcId) => unhandled.push([msgcode, rpcId]) });
    const call = settle(socket.call(EchoRpc, { text: "slow" }, { timeoutMs: 50 }));
    await sent(transport, 1);

    transport.reply(0, "late");
    transport.serverClose();
    vi.advanceTimersByTime(50);
    await flush();
    expect(call.error).toBeInstanceOf(ClientRpcTimeoutError);

    socket.update();
    expect(unhandled).toEqual([[EchoRpc.responseCode, transport.sent[0]!.rpcId]]);
  } finally {
    vi.useRealTimers();
  }
});

test("update() called from onStateChange delivers queued replies and fails the rest with the close cause", async () => {
  let socket!: RpcSocket;
  const opened = open({ onStateChange: (state) => { if (state === "closed") socket.update(); } });
  socket = opened.socket;
  const transport = opened.transport;
  const answered = settle(socket.call(EchoRpc, { text: "a" }));
  const unanswered = settle(socket.call(EchoRpc, { text: "b" }));
  await sent(transport, 2);

  transport.reply(0, "reply-a");
  transport.serverClose();
  await flush();
  expect(answered.value?.text).toBe("reply-a");
  expect(unanswered.error).toBeInstanceOf(ClientConnectionClosedError);
  expect((unanswered.error as ClientConnectionClosedError).cause).toMatchObject({ message: "server closed" });
});

test("an inbound overflow still fails every call, even one whose reply is queued", async () => {
  const errors: unknown[] = [];
  const { socket, transport } = open({ maxQueuedMessages: 1, onHandlerError: (_msgcode, error) => errors.push(error) });
  const call = settle(socket.call(EchoRpc, { text: "a" }));
  await sent(transport, 1);

  transport.reply(0, "reply-a");
  transport.push("overflow");
  await flush();
  expect(socket.state).toBe("closed");
  expect(call.error).toBeInstanceOf(ClientInboundOverflowError);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(ClientInboundOverflowError);
  expect(socket.queuedMessages).toBe(1);
});

test("a local close() drops the queue and fails every call", async () => {
  const { socket, transport } = open();
  const call = settle(socket.call(EchoRpc, { text: "a" }));
  await sent(transport, 1);

  transport.reply(0, "reply-a");
  socket.close();
  await flush();
  expect(call.error).toBeInstanceOf(ClientConnectionClosedError);
  expect(socket.queuedMessages).toBe(0);
  expect(socket.update()).toBe(0);
});
