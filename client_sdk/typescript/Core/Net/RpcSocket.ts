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
  ClientConnectionClosedError,
  ClientInboundOverflowError,
  ClientProtocolError,
  ClientRpcTimeoutError,
  ClientSdkError,
} from "./ClientError";
import {
  type ClientEndpoint,
  type ClientTransport,
  createClientTransport,
} from "./ClientTransport";

export interface RpcCallOptions {
  timeoutMs?: number;
}

export interface MessageWaitOptions {
  timeoutMs?: number;
}

export type ClientConnectionState = "idle" | "connecting" | "connected" | "closed";

export interface RpcSocketOptions {
  defaultTimeoutMs?: number;
  maxQueuedMessages?: number;
  onStateChange?: (state: ClientConnectionState) => void;
  onUnhandledMessage?: (msgcode: number, rpcId: number | undefined) => void;
  onHandlerError?: (msgcode: number, error: unknown) => void;
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
  private readonly inbound: Uint8Array[] = [];
  private inboundHead = 0;
  private readonly defaultTimeoutMs: number;
  private readonly maxQueuedMessages: number;
  private stateValue: ClientConnectionState = "idle";
  private closeCause?: ClientSdkError;
  private nextRpcId = 1;

  constructor(
    private readonly endpoint: ClientEndpoint,
    private readonly options: RpcSocketOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.maxQueuedMessages = options.maxQueuedMessages ?? 4_096;
    if (this.defaultTimeoutMs <= 0) throw new Error("defaultTimeoutMs 必须大于 0");
    if (!Number.isSafeInteger(this.maxQueuedMessages) || this.maxQueuedMessages <= 0) {
      throw new Error("maxQueuedMessages 必须是正整数");
    }
    this.transport = createClientTransport(endpoint);
    this.transport.setListener({
      onMessage: (frame) => this.enqueue(frame),
      onClose: (error) => this.handleClosed(error),
    });
  }

  get state(): ClientConnectionState {
    return this.stateValue;
  }

  get queuedMessages(): number {
    return this.inbound.length - this.inboundHead;
  }

  async connect(): Promise<void> {
    if (this.stateValue === "connected") return;
    if (this.stateValue === "closed") throw new ClientConnectionClosedError(this.endpoint);
    this.setState("connecting");
    try {
      await this.transport.connect();
      this.ensureNotClosed();
      this.setState("connected");
    } catch (cause) {
      const error = this.closedError(cause);
      this.handleClosed(error);
      throw error;
    }
  }

  update(maxMessages = 256): number {
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
      throw new Error("maxMessages 必须是正整数");
    }
    const count = Math.min(maxMessages, this.queuedMessages);
    for (let index = 0; index < count; index += 1) {
      const frame = this.inbound[this.inboundHead++];
      if (frame) this.handleMessage(frame);
    }
    if (this.inboundHead === this.inbound.length) {
      this.inbound.length = 0;
      this.inboundHead = 0;
    } else if (this.inboundHead >= 1_024) {
      this.inbound.splice(0, this.inboundHead);
      this.inboundHead = 0;
    }
    // 关闭前入队的帧已全部分发，仍在等待的 RPC 不会再有回复。 / Every frame queued before the close has been dispatched; remaining calls will get no reply.
    if (this.stateValue === "closed" && this.queuedMessages === 0 && this.pending.size > 0) {
      this.rejectAll(this.closeCause ?? new ClientConnectionClosedError(this.endpoint));
    }
    return count;
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
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    const response = descriptor.responseCodec.decode(responseFrame.subarray(2));
    if (response.rpcId !== rpcId) {
      throw new RpcError(
        0,
        `${descriptor.name} 的 rpcId 不匹配：收到 ${response.rpcId ?? 0}，期望 ${rpcId}`,
      );
    }
    if ((response.error ?? 0) !== 0) {
      throw new RpcError(
        response.error!,
        response.message || descriptor.name,
        response as unknown as Readonly<Record<string, unknown>>,
      );
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
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
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
    if (this.stateValue === "closed") return;
    this.setState("closed");
    this.inbound.length = 0;
    this.inboundHead = 0;
    this.rejectAll(new ClientConnectionClosedError(this.endpoint));
    this.transport.close();
  }

  private async requestFrame(
    rpcId: number,
    frame: Uint8Array,
    responseCode: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    await this.connect();
    this.ensureNotClosed();
    if (!this.transport.connected) {
      throw new ClientConnectionClosedError(this.endpoint);
    }
    if (this.pending.has(rpcId)) {
      throw new Error(`出现重复的 pending rpcId：${rpcId}`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(new ClientRpcTimeoutError(rpcId, timeoutMs));
      }, timeoutMs);
      this.pending.set(rpcId, { responseCode, resolve, reject, timer });
      this.transport.send(frame);
    });
  }

  private handleMessage(frame: Uint8Array): void {
    if (frame.length < 2) {
      this.options.onHandlerError?.(0, new ClientProtocolError("收到的消息帧短于 msgcode"));
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
          new ClientProtocolError(
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
      this.options.onUnhandledMessage?.(msgcode, rpcId);
      return;
    }
    for (const handler of handlers) {
      try {
        handler(frame, msgcode);
      } catch (error) {
        this.options.onHandlerError?.(msgcode, error);
      }
    }
  }

  private allocateRpcId(): number {
    const rpcId = this.nextRpcId;
    this.nextRpcId = (this.nextRpcId % 0xffff_ffff) + 1;
    return rpcId;
  }

  private rejectAll(error: Error, keep?: ReadonlySet<number>): void {
    for (const [rpcId, pending] of this.pending) {
      if (keep?.has(rpcId)) continue;
      this.pending.delete(rpcId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** 入站队列中已有回复帧的等待中 RPC。 / Pending calls whose reply frame is already queued. */
  private queuedReplyIds(): Set<number> | undefined {
    if (this.pending.size === 0 || this.queuedMessages === 0) return undefined;
    const ids = new Set<number>();
    for (let index = this.inboundHead; index < this.inbound.length; index += 1) {
      const frame = this.inbound[index];
      const rpcId = frame ? extractRpcId(frame) : undefined;
      if (rpcId !== undefined && this.pending.has(rpcId)) ids.add(rpcId);
    }
    return ids;
  }

  private enqueue(frame: Uint8Array): void {
    if (this.stateValue === "closed") return;
    if (this.queuedMessages >= this.maxQueuedMessages) {
      const error = new ClientInboundOverflowError(this.maxQueuedMessages);
      this.options.onHandlerError?.(0, error);
      this.handleClosed(error);
      this.transport.close();
      return;
    }
    this.inbound.push(frame);
  }

  private handleClosed(cause: unknown): void {
    if (this.stateValue === "closed") return;
    const error = this.closedError(cause);
    // 先记下原因：onStateChange 回调可能同步调用 update()，其中的收尾拒绝要用它。
    // Record the cause first: onStateChange may call update() synchronously, whose final rejection uses it.
    this.closeCause = error;
    this.setState("closed");
    // 连接关闭不等于丢弃已经收到的帧：顶号通知等单向消息和 RPC 回复都可能先入队、随后才收到 onclose，
    // 它们留给 update() 按到达顺序分发；只有回复不在队列里的 RPC 立即失败。入站队列溢出时全部立即失败。
    // A closed transport must not discard already-received frames: one-way messages such as takeover
    // notices and RPC replies can be queued before onclose, and update() dispatches them in arrival order.
    // Only calls without a queued reply fail now; an inbound overflow fails every call.
    const answered = error instanceof ClientInboundOverflowError ? undefined : this.queuedReplyIds();
    this.rejectAll(error, answered);
  }

  private setState(state: ClientConnectionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onStateChange?.(state);
  }

  private ensureNotClosed(): void {
    if (this.stateValue === "closed") throw new ClientConnectionClosedError(this.endpoint);
  }

  private closedError(cause: unknown): ClientSdkError {
    return cause instanceof ClientSdkError
      ? cause
      : new ClientConnectionClosedError(this.endpoint, cause);
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
