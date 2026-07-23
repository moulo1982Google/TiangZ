import assert from "node:assert/strict";

import {
  ClientConnectionClosedError,
  ClientInboundOverflowError,
  ClientRpcTimeoutError,
} from "../client_sdk/typescript/Core/Net/ClientError";
import { RpcSocket } from "../client_sdk/typescript/Core/Net/RpcSocket";
import {
  type ClientEndpoint,
  type ClientTransport,
  type ClientTransportListener,
  registerClientTransport,
} from "../client_sdk/typescript/Core/Net/ClientTransport";
import { packFrame } from "../client_sdk/typescript/Core/Protocol/Frame";
import { defineMessage } from "../client_sdk/typescript/Core/Protocol/Message";
import { BenchProtocol } from "../client_sdk/typescript/Generated/Model/bench/protocol/rpcs";

class ControlledTransport implements ClientTransport {
  connected = false;
  listener?: ClientTransportListener;
  respond = true;

  constructor(readonly endpoint: ClientEndpoint) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  send(frame: Uint8Array): void {
    if (!this.respond) return;
    const descriptor = BenchProtocol.RuntimePing;
    const request = descriptor.requestCodec.decode(frame.subarray(2));
    this.emit(packFrame(descriptor.responseCode, descriptor.responseCodec.encode({
      rpcId: request.rpcId,
      error: 0,
      seq: request.seq,
      payload: request.payload,
    })));
  }

  close(): void {
    this.connected = false;
  }

  setListener(listener: ClientTransportListener): void {
    this.listener = listener;
  }

  emit(frame: Uint8Array): void {
    this.listener?.onMessage(frame);
  }

  disconnect(error: Error): void {
    this.connected = false;
    this.listener?.onClose(error);
  }
}

const transports: ControlledTransport[] = [];
const unregister = registerClientTransport("tcp", (endpoint) => {
  const transport = new ControlledTransport(endpoint);
  transports.push(transport);
  return transport;
});

const endpoint: ClientEndpoint = { transport: "tcp", host: "127.0.0.1", port: 7000 };
const Push = defineMessage<{ value: number }>({
  name: "Test.Push",
  msgcode: 60000,
  codec: {
    encode: (value) => Uint8Array.of(value.value),
    decode: (payload) => ({ value: payload[0] ?? 0 }),
  },
});

async function main(): Promise<void> {
  try {
    const socket = new RpcSocket(endpoint);
    let resolved = false;
    const responsePromise = socket.call(BenchProtocol.RuntimePing, {
      seq: 7,
      payload: Uint8Array.of(1, 2, 3),
      delayMs: 0,
    }).then((response) => {
      resolved = true;
      return response;
    });
    await waitUntil(() => socket.queuedMessages === 1);
    assert.equal(resolved, false, "RPC response must wait for update");
    assert.equal(socket.queuedMessages, 1);
    assert.equal(socket.update(1), 1);
    assert.equal((await responsePromise).seq, 7);

    const pushes: number[] = [];
    socket.on(Push, (message) => pushes.push(message.value));
    transports[0]!.emit(packFrame(Push.msgcode, Push.codec.encode({ value: 9 })));
    assert.deepEqual(pushes, []);
    socket.update();
    assert.deepEqual(pushes, [9]);

    const unhandled: number[] = [];
    const unknownSocket = new RpcSocket(endpoint, {
      onUnhandledMessage: (msgcode) => unhandled.push(msgcode),
    });
    await unknownSocket.connect();
    transports.at(-1)!.emit(packFrame(65500, new Uint8Array()));
    unknownSocket.update();
    assert.deepEqual(unhandled, [65500]);
    unknownSocket.close();
    socket.close();

    const timeoutSocket = new RpcSocket(endpoint, { defaultTimeoutMs: 5 });
    await timeoutSocket.connect();
    transports.at(-1)!.respond = false;
    await assert.rejects(
      timeoutSocket.call(BenchProtocol.RuntimePing, { seq: 1, payload: new Uint8Array(), delayMs: 0 }),
      ClientRpcTimeoutError,
    );
    timeoutSocket.close();

    const disconnectedSocket = new RpcSocket(endpoint, { defaultTimeoutMs: 5_000 });
    await disconnectedSocket.connect();
    const disconnectedTransport = transports.at(-1)!;
    disconnectedTransport.respond = false;
    const disconnectedCall = disconnectedSocket.call(
      BenchProtocol.RuntimePing,
      { seq: 2, payload: new Uint8Array(), delayMs: 0 },
    );
    disconnectedTransport.disconnect(new Error("expected disconnect"));
    await assert.rejects(disconnectedCall, ClientConnectionClosedError);

    const errors: unknown[] = [];
    const overflowSocket = new RpcSocket(endpoint, {
      maxQueuedMessages: 1,
      onHandlerError: (_msgcode, error) => errors.push(error),
    });
    await overflowSocket.connect();
    const overflowTransport = transports.at(-1)!;
    overflowTransport.emit(packFrame(Push.msgcode, Push.codec.encode({ value: 1 })));
    overflowTransport.emit(packFrame(Push.msgcode, Push.codec.encode({ value: 2 })));
    assert.equal(overflowSocket.state, "closed");
    assert.ok(errors[0] instanceof ClientInboundOverflowError);

    console.log("client SDK runtime self-test passed");
  } finally {
    unregister();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
