import net from "node:net";
import { performance } from "node:perf_hooks";
import { packFrame } from "../app/core/protocol/registry";
import {
  C2S_RuntimePingCodec,
  S2C_RuntimePingCodec,
} from "../client_sdk/typescript/Generated/Model/bench/protocol/messages";
import { BenchProtocol } from "../client_sdk/typescript/Generated/Model/bench/protocol/rpcs";

interface Options {
  host: string;
  port: number;
  durationSeconds: number;
  warmupSeconds: number;
  concurrency: number;
  connections: number;
  payloadBytes: number;
  delayMs: number;
  drainTimeoutSeconds: number;
}

interface PendingRequest {
  startedAt: number;
  measured: boolean;
  seq: number;
}

const options = parseOptions(process.argv.slice(2));

async function run(options: Options): Promise<void> {
  const payload = new Uint8Array(options.payloadBytes);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = index & 0xff;
  }

  let nextRpcId = 1;
  let nextSeq = 1;
  let measurementStart = Number.POSITIVE_INFINITY;
  let sendDeadline = Number.POSITIVE_INFINITY;
  let completed = 0;
  let errors = 0;
  let peakInFlight = 0;
  const latencies: number[] = [];
  const clients: LoadConnection[] = [];

  const allocateRequest = () => {
    const now = performance.now();
    const rpcId = nextRpcId;
    nextRpcId = (nextRpcId % 0xffff_ffff) + 1;
    const seq = nextSeq++;
    return {
      frame: encodeRequest(rpcId, seq, payload, options.delayMs),
      rpcId,
      seq,
      startedAt: now,
      measured: now >= measurementStart && now < sendDeadline,
    };
  };

  const onResponse = (latencyMs: number, measured: boolean) => {
    if (!measured) return;
    completed += 1;
    latencies.push(latencyMs);
  };

  const onError = (error: Error) => {
    errors += 1;
    throw error;
  };

  const baseWindow = Math.floor(options.concurrency / options.connections);
  let remainingWindow = options.concurrency % options.connections;
  for (let index = 0; index < options.connections; index += 1) {
    const window = baseWindow + (remainingWindow-- > 0 ? 1 : 0);
    const client = new LoadConnection(
      options.host,
      options.port,
      window,
      allocateRequest,
      onResponse,
      onError,
      () => performance.now() < sendDeadline,
      () => {
        peakInFlight = Math.max(
          peakInFlight,
          clients.reduce((sum, item) => sum + item.inFlight, 0),
        );
      },
    );
    clients.push(client);
    await client.connect();
  }

  for (const client of clients) client.fillWindow();
  await delay(options.warmupSeconds * 1000);
  measurementStart = performance.now();
  sendDeadline = measurementStart + options.durationSeconds * 1000;
  await delay(options.durationSeconds * 1000);

  const drainDeadline = performance.now() + options.drainTimeoutSeconds * 1000;
  while (clients.some((client) => client.inFlight > 0)) {
    if (performance.now() >= drainDeadline) {
      errors += clients.reduce((sum, client) => sum + client.inFlight, 0);
      break;
    }
    await delay(10);
  }
  for (const client of clients) client.close();

  latencies.sort((left, right) => left - right);
  const elapsedSeconds = options.durationSeconds;
  const result = {
    requests: completed,
    requestsPerSecond: completed / elapsedSeconds,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? 0,
    errors,
    peakInFlight,
  };

  console.log("Runtime localhost load test");
  console.log(
    `target=${options.host}:${options.port} duration=${options.durationSeconds}s warmup=${options.warmupSeconds}s connections=${options.connections} concurrency=${options.concurrency} payload=${options.payloadBytes}B delay=${options.delayMs}ms`,
  );
  console.log(
    `requests=${result.requests} req/s=${result.requestsPerSecond.toFixed(0)} errors=${result.errors} peak_in_flight=${result.peakInFlight}`,
  );
  console.log(
    `latency_ms p50=${result.p50Ms.toFixed(3)} p95=${result.p95Ms.toFixed(3)} p99=${result.p99Ms.toFixed(3)} max=${result.maxMs.toFixed(3)}`,
  );

  if (result.errors !== 0) {
    process.exitCode = 1;
  }
}

class LoadConnection {
  private readonly socket = new net.Socket();
  private receiveBuffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly window: number,
    private readonly allocateRequest: () => {
      frame: Uint8Array;
      rpcId: number;
      seq: number;
      startedAt: number;
      measured: boolean;
    },
    private readonly onResponse: (latencyMs: number, measured: boolean) => void,
    private readonly onError: (error: Error) => void,
    private readonly shouldSend: () => boolean,
    private readonly onInFlight: (inFlight: number) => void,
  ) {}

  get inFlight(): number {
    return this.pending.size;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.setNoDelay(true);
      this.socket.once("error", reject);
      this.socket.connect(this.port, this.host, () => {
        this.socket.off("error", reject);
        this.socket.on("error", (error) => this.onError(error));
        this.socket.on("data", (chunk) => this.onData(chunk));
        resolve();
      });
    });
  }

  fillWindow(): void {
    while (this.pending.size < this.window && this.shouldSend()) {
      this.sendOne();
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private sendOne(): void {
    const request = this.allocateRequest();
    this.pending.set(request.rpcId, {
      startedAt: request.startedAt,
      measured: request.measured,
      seq: request.seq,
    });
    this.onInFlight(this.pending.size);

    const packet = Buffer.allocUnsafe(4 + request.frame.length);
    packet.writeUInt32BE(request.frame.length, 0);
    packet.set(request.frame, 4);
    this.socket.write(packet);
  }

  private onData(chunk: Buffer): void {
    this.receiveBuffer = this.receiveBuffer.length === 0
      ? chunk
      : Buffer.concat([this.receiveBuffer, chunk]);

    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32BE(0);
      if (this.receiveBuffer.length < 4 + length) return;
      const frame = this.receiveBuffer.subarray(4, 4 + length);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Uint8Array): void {
    const responseCode = (frame[0] << 8) | frame[1];
    if (responseCode !== BenchProtocol.RuntimePing.responseCode) {
      this.onError(new Error(`unexpected response msgcode: ${responseCode}`));
      return;
    }
    const response = S2C_RuntimePingCodec.decode(frame.subarray(2));
    const rpcId = response.rpcId ?? 0;
    const pending = this.pending.get(rpcId);
    if (!pending) {
      this.onError(new Error(`unknown response rpcId: ${rpcId}`));
      return;
    }
    this.pending.delete(rpcId);
    if (response.error) {
      this.onError(new Error(`RPC ${rpcId} failed: ${response.error} ${response.message ?? ""}`));
      return;
    }
    if (response.seq !== pending.seq || response.payload.length !== options.payloadBytes) {
      this.onError(new Error(`RPC ${rpcId} response payload mismatch`));
      return;
    }
    this.onResponse(performance.now() - pending.startedAt, pending.measured);
    this.fillWindow();
  }
}

function encodeRequest(
  rpcId: number,
  seq: number,
  payload: Uint8Array,
  delayMs: number,
): Uint8Array {
  return packFrame(
    BenchProtocol.RuntimePing.requestCode,
    C2S_RuntimePingCodec.encode({ rpcId, seq, payload, delayMs }),
  );
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--?/, "").toLowerCase();
    const value = args[index + 1];
    if (key && value) values.set(key, value);
  }
  const number = (name: string, fallback: number) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`invalid --${name}: ${values.get(name)}`);
    }
    return value;
  };
  const nonNegativeNumber = (name: string, fallback: number) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid --${name}: ${values.get(name)}`);
    }
    return value;
  };
  const concurrency = Math.floor(number("concurrency", 128));
  const connections = Math.floor(number("connections", 4));
  if (connections > concurrency) {
    throw new Error("connections cannot exceed concurrency");
  }
  return {
    host: values.get("host") ?? "127.0.0.1",
    port: Math.floor(number("port", 7400)),
    durationSeconds: number("duration", 10),
    warmupSeconds: number("warmup", 2),
    concurrency,
    connections,
    payloadBytes: Math.floor(number("payload", 256)),
    delayMs: Math.floor(nonNegativeNumber("delay", 0)),
    drainTimeoutSeconds: number("drain", 10),
  };
}

void run(options).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
