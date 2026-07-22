export type ClientTransportKind = "websocket" | "tcp" | "kcp";

export interface ClientEndpoint {
  transport: ClientTransportKind;
  host: string;
  port: number;
  secure?: boolean;
}

export interface ClientTransportListener {
  onMessage(frame: Uint8Array): void;
  onClose(error: Error): void;
}

export interface ClientTransport {
  readonly endpoint: ClientEndpoint;
  readonly connected: boolean;
  connect(): Promise<void>;
  send(frame: Uint8Array): void;
  close(): void;
  setListener(listener: ClientTransportListener): void;
}

export type ClientTransportFactory = (
  endpoint: ClientEndpoint,
) => ClientTransport;

export class UnsupportedTransportError extends Error {
  constructor(readonly transport: ClientTransportKind) {
    super(`当前平台不支持 ${transport} 传输协议`);
    this.name = "UnsupportedTransportError";
  }
}

const nativeFactories = new Map<ClientTransportKind, ClientTransportFactory>();

export function registerClientTransport(
  transport: "tcp" | "kcp",
  factory: ClientTransportFactory,
): () => void {
  nativeFactories.set(transport, factory);
  return () => {
    if (nativeFactories.get(transport) === factory) {
      nativeFactories.delete(transport);
    }
  };
}

export function createClientTransport(endpoint: ClientEndpoint): ClientTransport {
  validateEndpoint(endpoint);
  if (endpoint.transport === "websocket") {
    if (typeof globalThis.WebSocket !== "function") {
      throw new UnsupportedTransportError(endpoint.transport);
    }
    return new WebSocketClientTransport(endpoint);
  }

  const factory = nativeFactories.get(endpoint.transport);
  if (!factory) throw new UnsupportedTransportError(endpoint.transport);
  return factory(endpoint);
}

export function endpointWithAddress(
  endpoint: ClientEndpoint,
  host: string,
  port: number,
): ClientEndpoint {
  return { ...endpoint, host, port };
}

class WebSocketClientTransport implements ClientTransport {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private listener?: ClientTransportListener;

  constructor(readonly endpoint: ClientEndpoint) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  setListener(listener: ClientTransportListener): void {
    this.listener = listener;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    const url = formatWebSocketUrl(this.endpoint);
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      let opened = false;

      socket.onopen = () => {
        opened = true;
        this.socket = socket;
        this.connecting = undefined;
        resolve();
      };
      socket.onerror = () => {
        if (opened) return;
        this.connecting = undefined;
        reject(new Error(`连接失败：${url}`));
      };
      socket.onclose = () => {
        const error = new Error(
          opened ? `连接已关闭：${url}` : `连接建立期间已关闭：${url}`,
        );
        if (!opened) {
          this.connecting = undefined;
          reject(error);
        }
        if (this.socket === socket) this.socket = undefined;
        this.listener?.onClose(error);
      };
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.listener?.onMessage(new Uint8Array(event.data));
        } else {
          this.listener?.onClose(new Error("收到的 WebSocket 消息不是二进制帧"));
        }
      };
    });
    return this.connecting;
  }

  send(frame: Uint8Array): void {
    if (!this.socket || !this.connected) {
      throw new Error(`连接尚未打开：${formatEndpoint(this.endpoint)}`);
    }
    this.socket.send(Uint8Array.from(frame).buffer);
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

export function formatEndpoint(endpoint: ClientEndpoint): string {
  return `${endpoint.transport}://${endpoint.host}:${endpoint.port}`;
}

function formatWebSocketUrl(endpoint: ClientEndpoint): string {
  return `${endpoint.secure ? "wss" : "ws"}://${endpoint.host}:${endpoint.port}`;
}

function validateEndpoint(endpoint: ClientEndpoint): void {
  if (!endpoint.host.trim()) throw new Error("连接地址 host 不能为空");
  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535) {
    throw new Error(`连接端口无效：${endpoint.port}`);
  }
}
