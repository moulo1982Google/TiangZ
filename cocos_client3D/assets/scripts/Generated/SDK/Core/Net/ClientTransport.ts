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

const factories = new Map<ClientTransportKind, ClientTransportFactory>();

export function registerClientTransport(
  transport: ClientTransportKind,
  factory: ClientTransportFactory,
): () => void {
  factories.set(transport, factory);
  return () => {
    if (factories.get(transport) === factory) {
      factories.delete(transport);
    }
  };
}

export function supportedClientTransports(): readonly ClientTransportKind[] {
  return [...factories.keys()].sort();
}

export function createClientTransport(endpoint: ClientEndpoint): ClientTransport {
  validateEndpoint(endpoint);
  const factory = factories.get(endpoint.transport);
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

export function formatEndpoint(endpoint: ClientEndpoint): string {
  return `${endpoint.transport}://${endpoint.host}:${endpoint.port}`;
}

function validateEndpoint(endpoint: ClientEndpoint): void {
  if (!endpoint.host.trim()) throw new Error("连接地址 host 不能为空");
  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535) {
    throw new Error(`连接端口无效：${endpoint.port}`);
  }
}
