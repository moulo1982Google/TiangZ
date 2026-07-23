import assert from "node:assert/strict";
import {
  ClientMessageDispatcher,
  ClientMessageScope,
  clientMessageHandler,
  type ClientMessageHandler,
  type ClientMessageSource,
} from "../client_sdk/typescript/Core/Net/ClientMessageDispatcher";
import { defineMessage } from "../client_sdk/typescript/Core/Protocol/Message";

interface ProbeContext {
  values: number[];
}

interface ProbeMessage {
  value: number;
}

const ProbeScope = new ClientMessageScope<ProbeContext>("Probe");
const ProbeDescriptor = defineMessage<ProbeMessage>({
  name: "Probe.Message",
  msgcode: 1,
  codec: {
    encode: (message) => Uint8Array.of(message.value),
    decode: (payload) => ({ value: payload[0] }),
  },
});
const ErrorDescriptor = defineMessage<ProbeMessage>({
  name: "Probe.Error",
  msgcode: 2,
  codec: ProbeDescriptor.codec,
});

@clientMessageHandler(ProbeScope, ProbeDescriptor)
class ProbeHandler implements ClientMessageHandler<ProbeContext, ProbeMessage> {
  async handle(context: ProbeContext, message: ProbeMessage): Promise<void> {
    await Promise.resolve();
    context.values.push(message.value);
  }
}

@clientMessageHandler(ProbeScope, ErrorDescriptor)
class ErrorHandler implements ClientMessageHandler<ProbeContext, ProbeMessage> {
  async handle(): Promise<void> {
    throw new Error("expected async handler failure");
  }
}

class FakeMessageSource implements ClientMessageSource {
  private readonly handlers = new Map<number, Set<(message: ProbeMessage) => void>>();

  on<TMessage>(
    descriptor: { msgcode: number },
    handler: (message: TMessage) => void,
  ): () => void {
    const handlers = this.handlers.get(descriptor.msgcode) ?? new Set();
    handlers.add(handler as (message: ProbeMessage) => void);
    this.handlers.set(descriptor.msgcode, handlers);
    return () => handlers.delete(handler as (message: ProbeMessage) => void);
  }

  emit(msgcode: number, message: ProbeMessage): void {
    for (const handler of this.handlers.get(msgcode) ?? []) {
      handler(message);
    }
  }
}

async function main(): Promise<void> {
  const source = new FakeMessageSource();
  const context: ProbeContext = { values: [] };
  const errors: unknown[] = [];
  const dispatcher = new ClientMessageDispatcher(
    source,
    ProbeScope,
    context,
    { onError: (_descriptor, error) => errors.push(error) },
  );

  source.emit(ProbeDescriptor.msgcode, { value: 7 });
  await Promise.resolve();
  assert.deepEqual(context.values, [7]);
  assert.deepEqual(errors, []);

  source.emit(ErrorDescriptor.msgcode, { value: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /expected async handler failure/);

  dispatcher.dispose();
  source.emit(ProbeDescriptor.msgcode, { value: 8 });
  await Promise.resolve();
  assert.deepEqual(context.values, [7]);
  console.log("client message dispatcher self-test passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
