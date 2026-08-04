import type { ClientEndpoint } from "./ClientTransport";
import { formatEndpoint } from "./ClientTransport";

export class ClientSdkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ClientSdkError";
  }
}

export class ClientConnectionClosedError extends ClientSdkError {
  constructor(readonly endpoint: ClientEndpoint, cause?: unknown) {
    super(`连接已关闭：${formatEndpoint(endpoint)}`, cause);
    this.name = "ClientConnectionClosedError";
  }
}

export class ClientRpcTimeoutError extends ClientSdkError {
  constructor(readonly rpcId: number, readonly timeoutMs: number) {
    super(`RPC ${rpcId} 在 ${timeoutMs}ms 后超时`);
    this.name = "ClientRpcTimeoutError";
  }
}

export class ClientProtocolError extends ClientSdkError {
  constructor(message: string) {
    super(message);
    this.name = "ClientProtocolError";
  }
}

export class ClientInboundOverflowError extends ClientSdkError {
  constructor(readonly limit: number) {
    super(`客户端入站消息队列超过上限 ${limit}`);
    this.name = "ClientInboundOverflowError";
  }
}
