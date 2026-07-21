import { BinaryReader, readU16BE } from "./binary";
import { isPromiseLike, type MaybePromise } from "../async";
import type { AnyMessageDescriptor } from "./message";
import { RpcError } from "./RpcError";
import { AnyRpcDescriptor } from "./rpc";
import { SystemErrCode } from "./SystemErrCode";
import { nowMs } from "../metrics/latency";

export interface Route<TReq, TResp> {
  responseCode: number;
  decode(payload: Uint8Array): TReq;
  encode(response: TResp): Uint8Array;
  handle?: (
    request: TReq,
    context: ProtocolContext,
  ) => MaybePromise<TResp>;
}

export interface ProtocolContext {
  connectionId?: number;
  actorInstanceId?: number;
}

export interface ProtocolMetrics {
  record(name: string, elapsedMs: number, msgcode?: number): void;
}

interface MessageRoute<TMessage> {
  decode(payload: Uint8Array): TMessage;
  handle?: (
    message: TMessage,
    context: ProtocolContext,
  ) => MaybePromise<void>;
}

export class ProtocolRegistry {
  private readonly routes = new Map<number, Route<unknown, unknown>>();
  private readonly messageRoutes = new Map<number, MessageRoute<unknown>>();

  constructor(
    private readonly log: (message: string) => void = console.error,
    private readonly metrics?: ProtocolMetrics,
  ) {}

  registerKnownRpc(descriptor: AnyRpcDescriptor): void {
    this.routes.set(descriptor.requestCode, {
      responseCode: descriptor.responseCode,
      decode: descriptor.requestCodec.decode,
      encode: descriptor.responseCodec.encode,
    } as Route<unknown, unknown>);
  }

  registerKnownMessage(descriptor: AnyMessageDescriptor): void {
    this.messageRoutes.set(descriptor.msgcode, {
      decode: descriptor.codec.decode,
    });
  }

  register<TReq, TResp>(
    requestCode: number,
    route: Route<TReq, TResp>,
  ): void {
    this.routes.set(requestCode, route as Route<unknown, unknown>);
  }

  registerMessage<TMessage>(
    msgcode: number,
    route: MessageRoute<TMessage>,
  ): void {
    this.messageRoutes.set(msgcode, route as MessageRoute<unknown>);
  }

  handle(
    frame: Uint8Array,
    context: ProtocolContext = {},
  ): MaybePromise<Uint8Array | undefined> {
    if (frame.length < 2) {
      this.logSystemError(SystemErrCode.MalformedFrame, "frame too short");
      return undefined;
    }

    const msgcode = readU16BE(frame, 0);
    const payload = frame.subarray(2);
    let rpcId = 0;
    const route = this.routes.get(msgcode);
    if (!route) {
      const messageRoute = this.messageRoutes.get(msgcode);
      if (messageRoute) {
        return this.handleMessage(msgcode, payload, messageRoute, context);
      }
      this.logSystemError(
        SystemErrCode.UnknownMsgCode,
        `unknown msgcode: ${msgcode}`,
      );
      return undefined;
    }

    let request: unknown;
    const decodeStartedAt = this.metrics ? nowMs() : 0;
    try {
      request = route.decode(payload);
      rpcId = getRpcId(request) ?? rpcId;
    } catch (error) {
      if (this.metrics) {
        this.metrics.record("protocol.decode", nowMs() - decodeStartedAt, msgcode);
      }
      rpcId = extractRpcId(payload) ?? 0;
      return this.rpcErrorResponse(
        route,
        rpcId,
        SystemErrCode.DecodeFailed,
        error instanceof Error ? error.message : String(error),
        msgcode,
      );
    }
    if (this.metrics) {
      this.metrics.record("protocol.decode", nowMs() - decodeStartedAt, msgcode);
    }

    if (!route.handle) {
      return this.rpcErrorResponse(
        route,
        rpcId,
        SystemErrCode.HandlerNotFound,
        `handler not found for msgcode: ${msgcode}`,
        msgcode,
      );
    }

    let response: MaybePromise<unknown>;
    const handlerStartedAt = this.metrics ? nowMs() : 0;
    try {
      response = route.handle(request, context);
    } catch (error) {
      if (this.metrics) {
        this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
      }
      return this.handlerErrorResponse(route, rpcId, error, msgcode);
    }

    if (isPromiseLike(response)) {
      return Promise.resolve(response)
        .then((value) => {
          if (this.metrics) {
            this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
          }
          return this.rpcSuccessResponse(route, rpcId, value, msgcode);
        })
        .catch((error) => {
          if (this.metrics) {
            this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
          }
          return this.handlerErrorResponse(route, rpcId, error, msgcode);
        });
    }

    if (this.metrics) {
      this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
    }
    try {
      return this.rpcSuccessResponse(route, rpcId, response, msgcode);
    } catch (error) {
      return this.handlerErrorResponse(route, rpcId, error, msgcode);
    }
  }

  routingErrorResponse(
    frame: Uint8Array,
    code: number,
    message: string,
  ): Uint8Array | undefined {
    if (frame.length < 2) return undefined;
    const msgcode = readU16BE(frame, 0);
    const route = this.routes.get(msgcode);
    if (!route) {
      this.logSystemError(code, message);
      return undefined;
    }
    return this.rpcErrorResponse(
      route,
      extractRpcId(frame.subarray(2)) ?? 0,
      code,
      message,
      msgcode,
    );
  }

  reportSystemError(code: number, message: string): void {
    this.logSystemError(code, message);
  }

  private handleMessage(
    msgcode: number,
    payload: Uint8Array,
    route: MessageRoute<unknown>,
    context: ProtocolContext,
  ): MaybePromise<undefined> {
    let message: unknown;
    const decodeStartedAt = this.metrics ? nowMs() : 0;
    try {
      message = route.decode(payload);
    } catch (error) {
      if (this.metrics) {
        this.metrics.record("protocol.decode", nowMs() - decodeStartedAt, msgcode);
      }
      this.logSystemError(
        SystemErrCode.DecodeFailed,
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
    if (this.metrics) {
      this.metrics.record("protocol.decode", nowMs() - decodeStartedAt, msgcode);
    }

    if (!route.handle) {
      this.logSystemError(
        SystemErrCode.HandlerNotFound,
        `message handler not found for msgcode: ${msgcode}`,
      );
      return undefined;
    }

    const handlerStartedAt = this.metrics ? nowMs() : 0;
    try {
      const result = route.handle(message, context);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          () => {
            if (this.metrics) {
              this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
            }
            return undefined;
          },
          (error) => {
            if (this.metrics) {
              this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
            }
            this.logMessageHandlerError(msgcode, error);
            return undefined;
          },
        );
      }
      if (this.metrics) {
        this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
      }
    } catch (error) {
      if (this.metrics) {
        this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
      }
      this.logMessageHandlerError(msgcode, error);
    }
    return undefined;
  }

  private logMessageHandlerError(msgcode: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logSystemError(
      SystemErrCode.HandlerFailed,
      `message handler failed for msgcode ${msgcode}: ${message}`,
    );
  }

  private rpcSuccessResponse(
    route: Route<unknown, unknown>,
    rpcId: number,
    response: unknown,
    msgcode?: number,
  ): Uint8Array {
    setResponseMeta(response, rpcId, SystemErrCode.Success);
    const encodeStartedAt = this.metrics ? nowMs() : 0;
    const payload = route.encode(response);
    if (this.metrics) {
      this.metrics.record("protocol.encode", nowMs() - encodeStartedAt, msgcode);
    }
    return packFrame(route.responseCode, payload);
  }

  private handlerErrorResponse(
    route: Route<unknown, unknown>,
    rpcId: number,
    error: unknown,
    msgcode?: number,
  ): Uint8Array {
    const code =
      error instanceof RpcError ? error.code : SystemErrCode.HandlerFailed;
    const message = error instanceof Error ? error.message : String(error);
    return this.rpcErrorResponse(route, rpcId, code, message, msgcode);
  }

  private rpcErrorResponse(
    route: Route<unknown, unknown>,
    rpcId: number,
    code: number,
    message: string,
    msgcode?: number,
  ): Uint8Array {
    if (code < 10000) {
      this.logSystemError(code, message);
    }
    const response = { rpcId, error: code, message };
    const encodeStartedAt = this.metrics ? nowMs() : 0;
    const payload = route.encode(response);
    if (this.metrics) {
      this.metrics.record("protocol.encode", nowMs() - encodeStartedAt, msgcode);
    }
    return packFrame(route.responseCode, payload);
  }

  private logSystemError(code: number, message: string): void {
    this.log(`[err ${code}] ${message}`);
  }
}

export function packFrame(msgcode: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 2);
  frame[0] = (msgcode >>> 8) & 0xff;
  frame[1] = msgcode & 0xff;
  frame.set(payload, 2);
  return frame;
}

function getRpcId(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const rpcId = value.rpcId;
  return typeof rpcId === "number" ? rpcId : undefined;
}

function setResponseMeta(value: unknown, rpcId: number, error: number): void {
  if (!isRecord(value)) return;
  if (rpcId !== 0) value.rpcId = rpcId;
  if (typeof value.error !== "number") value.error = error;
}

function extractRpcId(payload: Uint8Array): number | undefined {
  try {
    const reader = new BinaryReader(payload);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
