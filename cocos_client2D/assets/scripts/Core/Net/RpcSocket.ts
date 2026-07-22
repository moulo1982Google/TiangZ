import { BinaryReader, readU16BE } from "../Protocol/Binary";
import { packFrame } from "../Protocol/Frame";
import type {
  IMessage,
  IRequest,
  IResponse,
  MessageDescriptor,
} from "../Protocol/Message";
import type { RpcDescriptor } from "../Protocol/Rpc";
import { RpcError } from "../Protocol/RpcError";
import {
  type ClientEndpoint,
  type ClientTransport,
  createClientTransport,
  formatEndpoint,
} from "./ClientTransport";

export interface RpcCallOptions {
  timeoutMs?: number;
}

export interface MessageWaitOptions {
  timeoutMs?: number;
}

export type MessageHandler = (frame: Uint8Array, msgcode: number) => void;

interface PendingRequest {
  responseCode: number;
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcSocket {
  private readonly transport: ClientTransport;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Map<number, Set<MessageHandler>>();
  private nextRpcId = 1;

  constructor(private readonly endpoint: ClientEndpoint) {
    this.transport = createClientTransport(endpoint);
    this.transport.setListener({
      onMessage: (frame) => this.handleMessage(frame),
      onClose: (error) => this.rejectAll(error),
    });
  }

  connect(): Promise<void> {
    return this.transport.connect();
  }

  async call<TRequest extends IRequest, TResponse extends IResponse>(
    descriptor: RpcDescriptor<TRequest, TResponse>,
    request: TRequest,
    options: RpcCallOptions = {},
  ): Promise<TResponse> {
    const rpcId = this.allocateRpcId();
    request.rpcId = rpcId;
    const responseFrame = await this.requestFrame(
      rpcId,
      packFrame(descriptor.requestCode, descriptor.requestCodec.encode(request)),
      descriptor.responseCode,
      options.timeoutMs ?? 5000,
    );
    const response = descriptor.responseCodec.decode(responseFrame.subarray(2));
    if (response.rpcId !== rpcId) {
      throw new RpcError(
        0,
        `${descriptor.name} 的 rpcId 不匹配：收到 ${response.rpcId ?? 0}，期望 ${rpcId}`,
      );
    }
    if ((response.error ?? 0) !== 0) {
      throw new RpcError(response.error!, response.message || descriptor.name);
    }
    return response;
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    await this.connect();
    this.transport.send(frame);
  }

  async send<TMessage extends IMessage>(
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
  ): Promise<void> {
    await this.sendFrame(
      packFrame(descriptor.msgcode, descriptor.codec.encode(message)),
    );
  }

  on<TMessage extends IMessage>(
    descriptor: MessageDescriptor<TMessage>,
    handler: (message: TMessage) => void,
  ): () => void;
  on(msgcode: number, handler: MessageHandler): () => void;
  on(
    descriptorOrCode: number | MessageDescriptor<IMessage>,
    handler: MessageHandler | ((message: IMessage) => void),
  ): () => void {
    if (typeof descriptorOrCode !== "number") {
      const descriptor = descriptorOrCode;
      const typedHandler: MessageHandler = (frame) => {
        (handler as (message: IMessage) => void)(
          descriptor.codec.decode(frame.subarray(2)),
        );
      };
      return this.on(descriptor.msgcode, typedHandler);
    }

    const msgcode = descriptorOrCode;
    const handlers = this.handlers.get(msgcode) ?? new Set<MessageHandler>();
    handlers.add(handler as MessageHandler);
    this.handlers.set(msgcode, handlers);
    return () => this.off(msgcode, handler as MessageHandler);
  }

  waitForMessage<TMessage extends IMessage>(
    descriptor: MessageDescriptor<TMessage>,
    options: MessageWaitOptions = {},
  ): Promise<TMessage> {
    const timeoutMs = options.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const unsubscribe = this.on(descriptor, (message) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(message);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(`${descriptor.name} 在 ${timeoutMs}ms 内没有到达`),
        );
      }, timeoutMs);
    });
  }

  off(msgcode: number, handler: MessageHandler): void {
    const handlers = this.handlers.get(msgcode);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.handlers.delete(msgcode);
  }

  close(): void {
    this.rejectAll(new Error(`客户端关闭连接：${formatEndpoint(this.endpoint)}`));
    this.transport.close();
  }

  private async requestFrame(
    rpcId: number,
    frame: Uint8Array,
    responseCode: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    await this.connect();
    if (!this.transport.connected) {
      throw new Error(`连接尚未打开：${formatEndpoint(this.endpoint)}`);
    }
    if (this.pending.has(rpcId)) {
      throw new Error(`出现重复的 pending rpcId：${rpcId}`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(new Error(`RPC ${rpcId} 在 ${timeoutMs}ms 后超时`));
      }, timeoutMs);
      this.pending.set(rpcId, { responseCode, resolve, reject, timer });
      this.transport.send(frame);
    });
  }

  private handleMessage(frame: Uint8Array): void {
    if (frame.length < 2) {
      console.error("收到的 WebSocket 消息帧短于 msgcode");
      return;
    }

    const msgcode = readU16BE(frame);
    const rpcId = extractRpcId(frame);
    const pending = rpcId === undefined ? undefined : this.pending.get(rpcId);
    if (pending && rpcId !== undefined) {
      this.pending.delete(rpcId);
      clearTimeout(pending.timer);
      if (pending.responseCode !== msgcode) {
        pending.reject(
          new Error(
            `RPC ${rpcId} 收到 msgcode ${msgcode}，期望 ${pending.responseCode}`,
          ),
        );
      } else {
        pending.resolve(frame);
      }
      return;
    }

    const handlers = this.handlers.get(msgcode);
    if (!handlers || handlers.size === 0) {
      console.warn(`未处理的服务端消息：msgcode=${msgcode} rpcId=${rpcId ?? 0}`);
      return;
    }
    for (const handler of handlers) {
      try {
        handler(frame, msgcode);
      } catch (error) {
        console.error(`服务端消息 Handler 执行失败：msgcode=${msgcode}`, error);
      }
    }
  }

  private allocateRpcId(): number {
    const rpcId = this.nextRpcId;
    this.nextRpcId = (this.nextRpcId % 0xffff_ffff) + 1;
    return rpcId;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function extractRpcId(frame: Uint8Array): number | undefined {
  if (frame.length < 2) return undefined;
  try {
    const reader = new BinaryReader(frame.subarray(2));
    while (!reader.eof()) {
      const tag = reader.tag();
      if (tag.fieldNo === 90 && tag.wireType === 0) {
        return reader.uint32();
      }
      reader.skip(tag.wireType);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
