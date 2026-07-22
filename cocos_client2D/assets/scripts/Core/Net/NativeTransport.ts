import {
  type ClientEndpoint,
  type ClientTransport,
  type ClientTransportKind,
  type ClientTransportListener,
  registerClientTransport,
} from "./ClientTransport";

interface NativeSocketApi {
  supports(transport: string): boolean;
  create(transport: string, host: string, port: number): number;
  state(handle: number): number;
  error(handle: number): string;
  send(handle: number, frame: Uint8Array): boolean;
  poll(handle: number): ArrayBuffer[];
  close(handle: number): void;
}

const nativeApi = (
  globalThis as typeof globalThis & { __tiangzNativeSocket?: NativeSocketApi }
).__tiangzNativeSocket;

if (nativeApi) {
  for (const kind of ["tcp", "kcp"] as const) {
    if (nativeApi.supports(kind)) {
      registerClientTransport(kind, (endpoint) => new NativeClientTransport(endpoint, nativeApi));
    }
  }
}

class NativeClientTransport implements ClientTransport {
  private handle = 0;
  private currentState = 0;
  private listener?: ClientTransportListener;
  private pumpTimer?: ReturnType<typeof setInterval>;
  private connecting?: Promise<void>;

  constructor(
    readonly endpoint: ClientEndpoint,
    private readonly api: NativeSocketApi,
  ) {}

  get connected(): boolean {
    return this.currentState === 1;
  }

  setListener(listener: ClientTransportListener): void {
    this.listener = listener;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.handle = this.api.create(
      this.endpoint.transport,
      this.endpoint.host,
      this.endpoint.port,
    );
    if (this.handle <= 0) {
      return Promise.reject(new Error(`创建 Native ${this.endpoint.transport} 连接失败`));
    }

    this.connecting = new Promise((resolve, reject) => {
      const pump = () => {
        this.currentState = this.api.state(this.handle);
        for (const frame of this.api.poll(this.handle)) {
          this.listener?.onMessage(new Uint8Array(frame));
        }
        if (this.currentState === 1) {
          this.connecting = undefined;
          resolve();
        } else if (this.currentState >= 2) {
          const error = new Error(
            this.api.error(this.handle) || `${this.endpoint.transport} 连接已关闭`,
          );
          this.stopPump();
          this.connecting = undefined;
          reject(error);
          this.listener?.onClose(error);
        }
      };
      this.pumpTimer = setInterval(pump, 10);
      pump();
    });
    return this.connecting;
  }

  send(frame: Uint8Array): void {
    if (!this.connected || !this.api.send(this.handle, frame)) {
      throw new Error(`${this.endpoint.transport} 连接尚未打开或发送队列已满`);
    }
  }

  close(): void {
    this.stopPump();
    if (this.handle > 0) this.api.close(this.handle);
    this.handle = 0;
    this.currentState = 2;
  }

  private stopPump(): void {
    if (this.pumpTimer !== undefined) clearInterval(this.pumpTimer);
    this.pumpTimer = undefined;
  }
}

export type NativeTransportKind = Extract<ClientTransportKind, "tcp" | "kcp">;
