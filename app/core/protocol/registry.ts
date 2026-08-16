import { BinaryReader, readU16BE } from "./binary";
import { isPromiseLike, type MaybePromise } from "../async";
import type { AnyMessageDescriptor } from "./message";
import { RpcError } from "./RpcError";
import { AnyRpcDescriptor } from "./rpc";
import { SystemErrCode } from "./SystemErrCode";
import { nowMs } from "../metrics/latency";
import { CoreLogger } from "../logging/Logger";
import type { Logger } from "../logging/Logger";

export interface Route<TReq, TResp> {
  responseCode: number;
  decode(payload: Uint8Array): TReq;
  encode(response: TResp): Uint8Array;
  createResponse?: () => TResp;
  handle?: (
    request: TReq,
    context: ProtocolContext,
  ) => MaybePromise<TResp>;
}

export interface ProtocolContext {
  connectionId?: number;
  actorInstanceId?: number;
  msgcode?: number;
  rpcId?: number;
  requestId?: string;
  logger?: Logger;
}

export type ProtocolOutcomeKind =
  | "success"
  | "business-error"
  | "system-error"
  | "decode-error"
  | "handler-not-found"
  | "message-handler-failed";

export interface ProtocolOutcome {
  kind: ProtocolOutcomeKind;
  code: number;
  context: ProtocolContext;
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

let nextProtocolRequestId = 1;

export class ProtocolRegistry {
  private readonly routes = new Map<number, Route<unknown, unknown>>();
  private readonly messageRoutes = new Map<number, MessageRoute<unknown>>();

  constructor(
    private readonly log: (message: string) => void = (message) =>
      CoreLogger.error("protocol registry error", { detail: message }),
    private readonly metrics?: ProtocolMetrics,
    private readonly outcome?: (outcome: ProtocolOutcome) => void,
  ) {}

  /** 安装生成的 RPC Codec；具体 Handler 在后续启动步骤绑定。 / Installs generated RPC codecs; the concrete handler is attached in a later bootstrap step. */
  registerKnownRpc(descriptor: AnyRpcDescriptor): void {
    this.routes.set(descriptor.requestCode, {
      responseCode: descriptor.responseCode,
      decode: descriptor.requestCodec.decode,
      encode: descriptor.responseCodec.encode,
      createResponse: () => descriptor.responseCodec.decode(new Uint8Array(0)),
    } as Route<unknown, unknown>);
  }

  /** 安装生成的单向 Codec，不创建响应契约。 / Installs generated one-way codecs without creating a response contract. */
  registerKnownMessage(descriptor: AnyMessageDescriptor): void {
    this.messageRoutes.set(descriptor.msgcode, {
      decode: descriptor.codec.decode,
    });
  }

  /** 安装底层 RPC 路由；普通业务代码应使用生成描述符。 / Installs a low-level RPC route; ordinary business code should use generated descriptors. */
  register<TReq, TResp>(
    requestCode: number,
    route: Route<TReq, TResp>,
  ): void {
    this.routes.set(requestCode, route as Route<unknown, unknown>);
  }

  /** 安装底层单向路由；Handler 失败只记日志，绝不返回响应。 / Installs a low-level one-way route whose handler failure is logged but never replied. */
  registerMessage<TMessage>(
    msgcode: number,
    route: MessageRoute<TMessage>,
  ): void {
    this.messageRoutes.set(msgcode, route as MessageRoute<unknown>);
  }

  /** 解码并分发一帧；只有输入为 RPC 时才返回响应帧。 / Decodes and dispatches one frame, returning a frame only when the input is an RPC. */
  handle(
    frame: Uint8Array,
    context: ProtocolContext = {},
  ): MaybePromise<Uint8Array | undefined> {
    if (frame.length < 2) {
      const requestContext = this.bindContext(context);
      this.logSystemError(SystemErrCode.MalformedFrame, "frame too short", requestContext);
      this.recordOutcome("system-error", SystemErrCode.MalformedFrame, requestContext);
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
      const requestContext = this.bindContext(context, msgcode);
      this.logSystemError(
        SystemErrCode.UnknownMsgCode,
        `unknown msgcode: ${msgcode}`,
        requestContext,
      );
      this.recordOutcome(
        "system-error",
        SystemErrCode.UnknownMsgCode,
        requestContext,
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
        this.bindContext(context, msgcode, rpcId),
        "decode-error",
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
        this.bindContext(context, msgcode, rpcId),
        "handler-not-found",
      );
    }

    const requestContext = this.bindContext(context, msgcode, rpcId);

    let response: MaybePromise<unknown>;
    const handlerStartedAt = this.metrics ? nowMs() : 0;
    try {
      response = route.handle(request, requestContext);
    } catch (error) {
      if (this.metrics) {
        this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
      }
      return this.handlerErrorResponse(route, rpcId, error, msgcode, requestContext);
    }

    if (isPromiseLike(response)) {
      return Promise.resolve(response)
        .then((value) => {
          if (this.metrics) {
            this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
          }
          return this.rpcSuccessResponse(route, rpcId, value, msgcode, requestContext);
        })
        .catch((error) => {
          if (this.metrics) {
            this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
          }
          return this.handlerErrorResponse(route, rpcId, error, msgcode, requestContext);
        });
    }

    if (this.metrics) {
      this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
    }
    try {
      return this.rpcSuccessResponse(route, rpcId, response, msgcode, requestContext);
    } catch (error) {
      return this.handlerErrorResponse(route, rpcId, error, msgcode, requestContext);
    }
  }

  routingErrorResponse(
    frame: Uint8Array,
    code: number,
    message: string,
    context: ProtocolContext = {},
  ): Uint8Array | undefined {
    if (frame.length < 2) return undefined;
    const msgcode = readU16BE(frame, 0);
    const route = this.routes.get(msgcode);
    if (!route) {
      const requestContext = this.bindContext(context, msgcode);
      this.logSystemError(code, message, requestContext);
      this.recordOutcome("system-error", code, requestContext);
      return undefined;
    }
    const rpcId = extractRpcId(frame.subarray(2)) ?? 0;
    return this.rpcErrorResponse(
      route,
      rpcId,
      code,
      message,
      msgcode,
      this.bindContext(context, msgcode, rpcId),
    );
  }

  reportSystemError(
    code: number,
    message: string,
    context: ProtocolContext = {},
  ): void {
    const requestContext = this.bindContext(context);
    this.logSystemError(code, message, requestContext);
    this.recordOutcome("system-error", code, requestContext);
  }

  private handleMessage(
    msgcode: number,
    payload: Uint8Array,
    route: MessageRoute<unknown>,
    context: ProtocolContext,
  ): MaybePromise<undefined> {
    const requestContext = this.bindContext(context, msgcode);
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
        requestContext,
      );
      this.recordOutcome("decode-error", SystemErrCode.DecodeFailed, requestContext);
      return undefined;
    }
    if (this.metrics) {
      this.metrics.record("protocol.decode", nowMs() - decodeStartedAt, msgcode);
    }

    if (!route.handle) {
      this.logSystemError(
        SystemErrCode.HandlerNotFound,
        `message handler not found for msgcode: ${msgcode}`,
        requestContext,
      );
      this.recordOutcome("handler-not-found", SystemErrCode.HandlerNotFound, requestContext);
      return undefined;
    }

    const handlerStartedAt = this.metrics ? nowMs() : 0;
    try {
      const result = route.handle(message, requestContext);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          () => {
            if (this.metrics) {
              this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
            }
            this.recordOutcome("success", SystemErrCode.Success, requestContext);
            return undefined;
          },
          (error) => {
            if (this.metrics) {
              this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
            }
            this.logMessageHandlerError(msgcode, error, requestContext);
            return undefined;
          },
        );
      }
      if (this.metrics) {
        this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
      }
      this.recordOutcome("success", SystemErrCode.Success, requestContext);
    } catch (error) {
      if (this.metrics) {
        this.metrics.record("protocol.handler", nowMs() - handlerStartedAt, msgcode);
      }
      this.logMessageHandlerError(msgcode, error, requestContext);
    }
    return undefined;
  }

  private logMessageHandlerError(
    msgcode: number,
    error: unknown,
    context: ProtocolContext,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logSystemError(
      SystemErrCode.HandlerFailed,
      `message handler failed for msgcode ${msgcode}: ${message}`,
      context,
    );
    this.recordOutcome("message-handler-failed", SystemErrCode.HandlerFailed, context);
  }

  private rpcSuccessResponse(
    route: Route<unknown, unknown>,
    rpcId: number,
    response: unknown,
    msgcode?: number,
    context: ProtocolContext = {},
  ): Uint8Array {
    setResponseMeta(response, rpcId, SystemErrCode.Success);
    const encodeStartedAt = this.metrics ? nowMs() : 0;
    const payload = route.encode(response);
    if (this.metrics) {
      this.metrics.record("protocol.encode", nowMs() - encodeStartedAt, msgcode);
    }
    const frame = packFrame(route.responseCode, payload);
    this.recordOutcome("success", SystemErrCode.Success, context);
    return frame;
  }

  private handlerErrorResponse(
    route: Route<unknown, unknown>,
    rpcId: number,
    error: unknown,
    msgcode?: number,
    context: ProtocolContext = {},
  ): Uint8Array {
    const code =
      error instanceof RpcError ? error.code : SystemErrCode.HandlerFailed;
    const message = error instanceof Error ? error.message : String(error);
    const response = error instanceof RpcError ? error.response : undefined;
    return this.rpcErrorResponse(route, rpcId, code, message, msgcode, context, undefined, response);
  }

  private rpcErrorResponse(
    route: Route<unknown, unknown>,
    rpcId: number,
    code: number,
    message: string,
    msgcode?: number,
    context: ProtocolContext = {},
    outcomeKind?: ProtocolOutcomeKind,
    errorResponse?: Readonly<Record<string, unknown>>,
  ): Uint8Array {
    if (code < 10000) {
      this.logSystemError(code, message, context);
    }
    const response = route.createResponse?.() ?? {};
    if (isRecord(response) && errorResponse) {
      Object.assign(response, errorResponse);
    }
    setResponseMeta(response, rpcId, code);
    if (isRecord(response)) response.message = message;
    const encodeStartedAt = this.metrics ? nowMs() : 0;
    const payload = route.encode(response);
    if (this.metrics) {
      this.metrics.record("protocol.encode", nowMs() - encodeStartedAt, msgcode);
    }
    const frame = packFrame(route.responseCode, payload);
    this.recordOutcome(
      outcomeKind ?? (code < 10000 ? "system-error" : "business-error"),
      code,
      context,
    );
    return frame;
  }

  private logSystemError(
    code: number,
    message: string,
    context?: ProtocolContext,
  ): void {
    if (context?.logger) {
      context.logger.error("protocol error", { errorCode: code, detail: message });
      return;
    }
    this.log(`[err ${code}] ${message}`);
  }

  private bindContext(
    context: ProtocolContext,
    msgcode?: number,
    rpcId?: number,
  ): ProtocolContext {
    const requestId = context.requestId ?? allocateRequestId();
    const fields = {
      ...(context.connectionId === undefined
        ? {}
        : { connectionId: context.connectionId }),
      ...(context.actorInstanceId === undefined
        ? {}
        : { actorId: context.actorInstanceId }),
      ...(msgcode === undefined ? {} : { msgcode }),
      ...(rpcId === undefined || rpcId === 0 ? {} : { rpcId }),
      requestId,
    };
    return {
      ...context,
      ...fields,
      logger: context.logger?.child(fields),
    };
  }

  private recordOutcome(
    kind: ProtocolOutcomeKind,
    code: number,
    context: ProtocolContext,
  ): void {
    this.outcome?.({ kind, code, context });
  }
}

function allocateRequestId(): string {
  const requestId = String(nextProtocolRequestId);
  nextProtocolRequestId = nextProtocolRequestId >= Number.MAX_SAFE_INTEGER
    ? 1
    : nextProtocolRequestId + 1;
  return requestId;
}

/** 打包内部 `[msgcode][payload]`；长度前缀由传输层另行添加。 / Packs internal `[msgcode][payload]`; transports add the length prefix separately. */
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
