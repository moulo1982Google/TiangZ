import { isPromiseLike, type MaybePromise } from "../async";

export interface TraceContextValue {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

export interface TraceSpanSpec {
  readonly name: string;
  readonly kind: "server" | "client" | "internal";
  readonly parent?: TraceContextValue;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

interface HostTraceSpan {
  readonly handle: number;
  readonly traceId: string;
  readonly spanId: string;
}

type PromiseHook = (promise: Promise<unknown>, parent?: Promise<unknown>) => void;
type HostPromiseHooks = (
  init?: PromiseHook,
  before?: PromiseHook,
  after?: PromiseHook,
  resolve?: PromiseHook,
) => void;

type HostStartTraceSpan = (
  name: string,
  kind: string,
  parentTraceId: string,
  parentSpanId: string,
  attributes: string,
) => string;

type HostEndTraceSpan = (handle: number, failed: boolean, detail: string) => void;

const promiseContexts = new WeakMap<Promise<unknown>, TraceContextValue>();
const contextStack: Array<TraceContextValue | undefined> = [];
let currentContext: TraceContextValue | undefined;
let tracingEnabled = false;
let traceSampleRate = 100;
let rootTraceCounter = 0;
let idState = initialIdState();
let promiseHooksInstalled = false;

/**
 * 配置单V8的Trace采样并安装Promise上下文继承；禁用时不包装内部帧。
 * Configures trace sampling for one V8 and installs Promise context inheritance;
 * disabled tracing does not wrap inner frames.
 */
export function ConfigureTraceContext(
  config?: { readonly enabled?: boolean; readonly sampleRate?: number },
): void {
  tracingEnabled = config?.enabled === true;
  traceSampleRate = requireSampleRate(config?.sampleRate ?? 100);
  if (tracingEnabled) installPromiseHooks();
}

export function CurrentTraceContext(): TraceContextValue | undefined {
  return currentContext;
}

/** 在指定上下文中同步启动任务；Promise hooks负责后续await恢复。 / Starts work synchronously in one context; Promise hooks restore it after awaits. */
export function RunWithTraceContext<T>(
  context: TraceContextValue | undefined,
  body: () => T,
): T {
  const previous = currentContext;
  currentContext = context;
  try {
    return body();
  } finally {
    currentContext = previous;
  }
}

/** 创建一个有界生命周期Span，并同时覆盖同步与异步完成路径。 / Creates a bounded span and covers both synchronous and asynchronous completion paths. */
export function RunTraceSpan<T>(
  spec: TraceSpanSpec,
  body: (context: TraceContextValue | undefined) => MaybePromise<T>,
): MaybePromise<T> {
  if (!tracingEnabled) return body(spec.parent);
  const span = startSpan(spec);
  let result: MaybePromise<T>;
  try {
    result = RunWithTraceContext(span.context, () => body(span.context));
  } catch (error) {
    endSpan(span.handle, error);
    throw error;
  }
  if (!isPromiseLike(result)) {
    endSpan(span.handle);
    return result;
  }
  return Promise.resolve(result).then(
    (value) => {
      endSpan(span.handle);
      return value;
    },
    (error) => {
      endSpan(span.handle, error);
      throw error;
    },
  );
}

export function TraceContextFromCarrier(
  traceId: string,
  spanId: string,
  sampled: boolean,
): TraceContextValue {
  requireHexId(traceId, 32, "traceId");
  requireHexId(spanId, 16, "spanId");
  return { traceId, spanId, sampled };
}

function startSpan(spec: TraceSpanSpec): {
  readonly handle: number;
  readonly context: TraceContextValue;
} {
  const parent = spec.parent ?? currentContext;
  const sampled = parent?.sampled ?? shouldSampleRoot();
  if (!sampled) {
    return {
      handle: 0,
      context: {
        traceId: parent?.traceId ?? newHexId(16),
        spanId: newHexId(8),
        sampled: false,
      },
    };
  }

  const host = globalThis as typeof globalThis & { __hostStartTraceSpan?: HostStartTraceSpan };
  try {
    const raw = host.__hostStartTraceSpan?.(
      spec.name,
      spec.kind,
      parent?.traceId ?? "",
      parent?.spanId ?? "",
      serializeAttributes(spec.attributes),
    );
    if (raw) {
      const value = JSON.parse(raw) as HostTraceSpan;
      if (Number.isSafeInteger(value.handle) && value.handle > 0) {
        requireHexId(value.traceId, 32, "host traceId");
        requireHexId(value.spanId, 16, "host spanId");
        return {
          handle: value.handle,
          context: { traceId: value.traceId, spanId: value.spanId, sampled: true },
        };
      }
    }
  } catch {
    // Trace export is diagnostic only; exporter failure must not fail gameplay.
  }
  return {
    handle: 0,
    context: {
      traceId: parent?.traceId ?? newHexId(16),
      spanId: newHexId(8),
      sampled: true,
    },
  };
}

function endSpan(handle: number, error?: unknown): void {
  if (handle === 0) return;
  const host = globalThis as typeof globalThis & { __hostEndTraceSpan?: HostEndTraceSpan };
  try {
    host.__hostEndTraceSpan?.(handle, error !== undefined, errorText(error));
  } catch {
    // Span completion remains best-effort and never changes request outcome.
  }
}

function installPromiseHooks(): void {
  if (promiseHooksInstalled) return;
  const host = globalThis as typeof globalThis & { __hostSetPromiseHooks?: HostPromiseHooks };
  if (!host.__hostSetPromiseHooks) return;
  host.__hostSetPromiseHooks(
    (promise, parent) => {
      const inherited = currentContext ?? (parent ? promiseContexts.get(parent) : undefined);
      if (inherited) promiseContexts.set(promise, inherited);
    },
    (promise) => {
      contextStack.push(currentContext);
      currentContext = promiseContexts.get(promise);
    },
    () => {
      currentContext = contextStack.pop();
    },
  );
  promiseHooksInstalled = true;
}

function shouldSampleRoot(): boolean {
  rootTraceCounter = (rootTraceCounter + 1) % traceSampleRate;
  return rootTraceCounter === 0;
}

function requireSampleRate(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error("trace sampleRate must be an integer within 1..1000000");
  }
  return value;
}

function newHexId(bytes: number): string {
  let result = "";
  for (let index = 0; index < bytes; index += 1) {
    idState ^= idState << 13;
    idState ^= idState >>> 17;
    idState ^= idState << 5;
    result += (idState & 0xff).toString(16).padStart(2, "0");
  }
  if (/^0+$/.test(result)) return `${"0".repeat(result.length - 1)}1`;
  return result;
}

function initialIdState(): number {
  const time = Date.now() >>> 0;
  const random = Math.floor(Math.random() * 0xffff_ffff) >>> 0;
  return (time ^ random ^ 0x9e37_79b9) || 1;
}

function requireHexId(value: string, length: number, name: string): void {
  if (value.length !== length || !/^[0-9a-f]+$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${name} must be a non-zero ${length}-character lowercase hex id`);
  }
}

function serializeAttributes(value: Readonly<Record<string, unknown>> | undefined): string {
  if (!value) return "{}";
  try {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested);
  } catch {
    return "{}";
  }
}

function errorText(error: unknown): string {
  if (error === undefined) return "";
  return error instanceof Error ? error.message : String(error);
}
