import assert from "node:assert/strict";

type PromiseHook = (promise: Promise<unknown>, parent?: Promise<unknown>) => void;

const hooks: {
  init?: PromiseHook;
  before?: PromiseHook;
  after?: PromiseHook;
} = {};
const started: Array<Record<string, unknown>> = [];
const ended: Array<{ handle: number; failed: boolean; detail: string }> = [];
let nextHandle = 1;

Object.assign(globalThis, {
  __hostSetPromiseHooks(init?: PromiseHook, before?: PromiseHook, after?: PromiseHook): void {
    hooks.init = init;
    hooks.before = before;
    hooks.after = after;
  },
  __hostStartTraceSpan(
    name: string,
    kind: string,
    parentTraceId: string,
    parentSpanId: string,
    attributes: string,
  ): string {
    const handle = nextHandle++;
    started.push({ name, kind, parentTraceId, parentSpanId, attributes: JSON.parse(attributes) });
    return JSON.stringify({
      handle,
      traceId: parentTraceId || "0123456789abcdef0123456789abcdef",
      spanId: handle.toString(16).padStart(16, "0"),
    });
  },
  __hostEndTraceSpan(handle: number, failed: boolean, detail: string): void {
    ended.push({ handle, failed, detail });
  },
});

void main();

async function main(): Promise<void> {
  const trace = await import("../app/core/telemetry/TraceContext");
  const envelope = await import("../app/core/process/TraceEnvelope");

  trace.ConfigureTraceContext({ enabled: true, sampleRate: 1 });
  assert.ok(hooks.init && hooks.before && hooks.after, "promise hooks should be installed");

  const result = await trace.RunTraceSpan(
    {
      name: "root request",
      kind: "server",
      attributes: { msgcode: 101, bigint: 42n },
    },
    async (root) => {
      assert.ok(root);
      assert.deepEqual(trace.CurrentTraceContext(), root);
      return await trace.RunTraceSpan(
        { name: "scene call", kind: "client", parent: root },
        (child) => {
          assert.equal(child?.traceId, root.traceId);
          assert.notEqual(child?.spanId, root.spanId);
          return 42;
        },
      );
    },
  );
  assert.equal(result, 42);
  assert.equal(started.length, 2);
  assert.deepEqual(ended.map((entry) => entry.failed), [false, false]);

  const inherited = trace.TraceContextFromCarrier(
    "11111111111111111111111111111111",
    "2222222222222222",
    true,
  );
  const pending = Promise.resolve();
  trace.RunWithTraceContext(inherited, () => hooks.init!(pending));
  assert.equal(trace.CurrentTraceContext(), undefined);
  hooks.before!(pending);
  assert.deepEqual(trace.CurrentTraceContext(), inherited);
  hooks.after!(pending);
  assert.equal(trace.CurrentTraceContext(), undefined);

  const businessFrame = Uint8Array.of(0, 41, 1, 2, 3, 4);
  const wrapped = envelope.encodeTraceEnvelope(businessFrame, inherited);
  const decoded = envelope.decodeTraceEnvelope(wrapped);
  assert.deepEqual(decoded.context, inherited);
  assert.deepEqual([...decoded.frame], [...businessFrame]);
  assert.throws(
    () => envelope.decodeTraceEnvelope(wrapped.subarray(0, 27)),
    /invalid trace envelope/,
  );

  console.log("trace context self test passed");
}
