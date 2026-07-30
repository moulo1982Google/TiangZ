import {
  type ClientEndpoint,
  type ClientTransport,
  type ClientTransportListener,
  formatEndpoint,
  registerClientTransport,
} from "./ClientTransport";

interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: ArrayBuffer): void;
  close(): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

const WebSocketClass = (
  globalThis as typeof globalThis & { WebSocket?: WebSocketCtor }
).WebSocket;

if (WebSocketClass) {
  registerClientTransport("websocket", (endpoint) => (
    new BrowserWebSocketTransport(endpoint, WebSocketClass)
  ));
}

class BrowserWebSocketTransport implements ClientTransport {
  private socket?: WebSocketLike;
  private connecting?: Promise<void>;
  private listener?: ClientTransportListener;

  constructor(
    readonly endpoint: ClientEndpoint,
    private readonly WebSocketType: WebSocketCtor,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  setListener(listener: ClientTransportListener): void {
    this.listener = listener;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const url = formatWebSocketUrl(this.endpoint);
    this.connecting = new Promise((resolve, reject) => {
      const socket = new this.WebSocketType(url);
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
        const error = new Error(opened ? `连接已关闭：${url}` : `连接建立期间已关闭：${url}`);
        if (!opened) {
          this.connecting = undefined;
          reject(error);
        }
        if (this.socket === socket) this.socket = undefined;
        this.listener?.onClose(error);
      };
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) this.listener?.onMessage(new Uint8Array(event.data));
        else this.listener?.onClose(new Error("收到的 WebSocket 消息不是 ArrayBuffer"));
      };
    });
    return this.connecting;
  }

  send(frame: Uint8Array): void {
    if (!this.socket || !this.connected) throw new Error(`连接尚未打开：${formatEndpoint(this.endpoint)}`);
    this.socket.send(Uint8Array.from(frame).buffer);
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

function formatWebSocketUrl(endpoint: ClientEndpoint): string {
  return `${endpoint.secure ? "wss" : "ws"}://${endpoint.host}:${endpoint.port}`;
}
