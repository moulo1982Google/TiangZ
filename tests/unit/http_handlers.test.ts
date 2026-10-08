import { afterEach, beforeEach, expect, test } from "vitest";
import { ProcessRuntime } from "../../app/core/process/ProcessRuntime";
import { EntryScene } from "../../app/core/process/EntryScene";
import { entryScene } from "../../app/core/process/registry";
import {
  decodeHttpRequest,
  HttpError,
  httpHandler,
  jsonResponse,
  type HttpRequest,
  type HttpResponse,
  type SceneHttpHandler,
} from "../../app/core/process/httpHandlers";
import { utf8Decode, utf8Encode } from "../../app/core/protocol/binary";

@entryScene("HttpFixture")
class HttpFixture extends EntryScene {
  hits = 0n;
}

@httpHandler(HttpFixture, "GET", "/status")
class StatusHandler implements SceneHttpHandler<HttpFixture> {
  handle(scene: HttpFixture, request: HttpRequest): HttpResponse {
    scene.hits += 1n;
    return jsonResponse({ hits: scene.hits, name: request.query.get("name") ?? null });
  }
}

@httpHandler(HttpFixture, "POST", "/echo")
class EchoHandler implements SceneHttpHandler<HttpFixture> {
  async handle(_scene: HttpFixture, request: HttpRequest): Promise<HttpResponse> {
    await Promise.resolve();
    const value = request.json<{ text: string }>();
    return { status: 201, headers: { "x-echo": "1" }, body: value.text };
  }
}

@httpHandler(HttpFixture, "GET", "/forbidden")
class ForbiddenHandler implements SceneHttpHandler<HttpFixture> {
  handle(): HttpResponse {
    throw new HttpError(403, "no access");
  }
}

@httpHandler(HttpFixture, "GET", "/boom")
class BoomHandler implements SceneHttpHandler<HttpFixture> {
  handle(): HttpResponse {
    throw new Error("secret internal detail");
  }
}

@httpHandler(HttpFixture, "GET", "/invalid")
class InvalidResponseHandler implements SceneHttpHandler<HttpFixture> {
  handle(): HttpResponse {
    return { status: 99 };
  }
}

let finishHeldRequest: (() => void) | undefined;
@httpHandler(HttpFixture, "POST", "/hold")
class HeldHandler implements SceneHttpHandler<HttpFixture> {
  async handle(): Promise<HttpResponse> {
    await new Promise<void>((resolve) => { finishHeldRequest = resolve; });
    return jsonResponse({ finished: true });
  }
}

interface Reply {
  status: number;
  headers: Map<string, string>;
  body: string;
}

let replies: Map<number, Reply>;
let delivered: boolean;
const expiredRequests = new Set<number>();
const discardedRequests = new Set<number>();

beforeEach(() => {
  replies = new Map();
  delivered = true;
  (globalThis as { __hostHttp?: unknown }).__hostHttp = {
    isPending: (requestId: number) => !expiredRequests.has(requestId),
    discard: (requestId: number) => { discardedRequests.add(requestId); },
    respond(requestId: number, status: number, headersJson: string, body: Uint8Array): boolean {
      // 与 Rust op 一致：非法状态码抛 TypeError，请求保持等待。 / Mirrors the Rust op: invalid status throws.
      if (status < 200 || status > 599) throw new TypeError(`HTTP status ${status} must be between 200 and 599`);
      replies.set(requestId, {
        status,
        headers: new Map(JSON.parse(headersJson) as [string, string][]),
        body: utf8Decode(body),
      });
      return delivered;
    },
  };
});

afterEach(() => {
  finishHeldRequest = undefined;
  expiredRequests.clear();
  discardedRequests.clear();
  delete (globalThis as { __hostHttp?: unknown }).__hostHttp;
});

function encodeRequest(
  method: string,
  path: string,
  options: { query?: string; headers?: [string, string][]; body?: string } = {},
): Uint8Array {
  const meta = utf8Encode(JSON.stringify({
    method,
    path,
    query: options.query ?? "",
    headers: options.headers ?? [],
    remoteAddress: "127.0.0.1:50000",
  }));
  const body = utf8Encode(options.body ?? "");
  const payload = new Uint8Array(4 + meta.length + body.length);
  new DataView(payload.buffer).setUint32(0, meta.length, true);
  payload.set(meta, 4);
  payload.set(body, 4 + meta.length);
  return payload;
}

async function withRuntime(run: (runtime: ProcessRuntime) => Promise<void>): Promise<void> {
  const scene = { name: "http", sceneType: "HttpFixture", innerIp: "127.0.0.1", port: 12345, http: { port: 12346 } };
  const runtime = new ProcessRuntime({ process: { name: "http-handlers" }, scenes: [scene], knownScenes: [scene], tickMs: 50 });
  await runtime.start();
  try {
    await run(runtime);
  } finally {
    await runtime.stop();
  }
}

async function settle(runtime: ProcessRuntime): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await runtime.update(false);
    // 让异步 Handler 的 Promise 链走完，相当于宿主两次 Update 之间的事件循环。
    // Let async handler chains finish, like the host event loop between two updates.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("decodes query, headers, and body without Web APIs", () => {
  const request = decodeHttpRequest(encodeRequest("POST", "/x", {
    query: "a=1&b=hello+world&c=%E4%B8%AD&a=2&bad=%zz&flag",
    headers: [["x-tag", "one"], ["x-tag", "two"]],
    body: "{\"ok\":true}",
  }));
  expect(request.query.get("a")).toBe("1");
  expect(request.query.get("b")).toBe("hello world");
  expect(request.query.get("c")).toBe("中");
  expect(request.query.get("bad")).toBe("%zz");
  expect(request.query.get("flag")).toBe("");
  expect(request.headers.get("x-tag")).toBe("one, two");
  expect(request.remoteAddress).toBe("127.0.0.1:50000");
  expect(request.json()).toEqual({ ok: true });
  expect(() => decodeHttpRequest(new Uint8Array([9, 0, 0, 0]))).toThrow("truncated");
});

test("rejects unsupported methods and malformed paths at registration", () => {
  expect(() => httpHandler(HttpFixture, "HEAD" as never, "/x")).toThrow("unsupported");
  expect(() => httpHandler(HttpFixture, "GET", "x")).toThrow("absolute path");
  expect(() => httpHandler(HttpFixture, "GET", "/x?y=1")).toThrow("absolute path");
  expect(() => httpHandler(HttpFixture, "GET", "/a b")).toThrow("absolute path");
});

test("dispatches sync and async handlers through the Scene mailbox", async () => {
  await withRuntime(async (runtime) => {
    runtime.pushHostHttpRequest(0, 1, encodeRequest("GET", "/status", { query: "name=tools" }));
    runtime.pushHostHttpRequest(0, 2, encodeRequest("POST", "/echo", { body: "{\"text\":\"hi\"}" }));
    runtime.pushHostHttpRequest(0, 3, encodeRequest("GET", "/status"));
    await settle(runtime);

    expect(replies.get(1)).toEqual({
      status: 200,
      headers: new Map([["content-type", "application/json; charset=utf-8"]]),
      body: "{\"hits\":\"1\",\"name\":\"tools\"}",
    });
    expect(replies.get(2)?.status).toBe(201);
    expect(replies.get(2)?.headers.get("x-echo")).toBe("1");
    expect(replies.get(2)?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(replies.get(2)?.body).toBe("hi");
    // ordered mailbox：异步 echo 完成后才处理第三个请求。 / Ordered mailbox runs the third request after the async echo.
    expect(replies.get(3)?.body).toBe("{\"hits\":\"2\",\"name\":null}");
  });
});

test("maps missing routes, HttpError, bad JSON, failures, and invalid responses", async () => {
  await withRuntime(async (runtime) => {
    runtime.pushHostHttpRequest(0, 10, encodeRequest("GET", "/missing"));
    runtime.pushHostHttpRequest(0, 11, encodeRequest("DELETE", "/status"));
    runtime.pushHostHttpRequest(0, 12, encodeRequest("GET", "/forbidden"));
    runtime.pushHostHttpRequest(0, 13, encodeRequest("POST", "/echo", { body: "not json" }));
    runtime.pushHostHttpRequest(0, 14, encodeRequest("GET", "/boom"));
    runtime.pushHostHttpRequest(0, 15, encodeRequest("GET", "/invalid"));
    runtime.pushHostHttpRequest(0, 16, new Uint8Array([1, 2]));
    await settle(runtime);

    expect(replies.get(10)).toMatchObject({ status: 404, body: "{\"error\":\"not found\"}" });
    expect(replies.get(11)?.status).toBe(405);
    expect(replies.get(11)?.headers.get("allow")).toBe("GET");
    expect(replies.get(12)).toMatchObject({ status: 403, body: "{\"error\":\"no access\"}" });
    expect(replies.get(13)).toMatchObject({ status: 400, body: "{\"error\":\"request body is not valid JSON\"}" });
    expect(replies.get(14)).toMatchObject({ status: 500, body: "{\"error\":\"internal error\"}" });
    expect(replies.get(15)).toMatchObject({ status: 500, body: "{\"error\":\"internal error\"}" });
    expect(replies.get(16)?.status).toBe(400);
  });
});

test("a late reply after host timeout does not throw", async () => {
  await withRuntime(async (runtime) => {
    delivered = false;
    runtime.pushHostHttpRequest(0, 20, encodeRequest("GET", "/status"));
    await settle(runtime);
    expect(replies.get(20)?.status).toBe(200);
  });
});

test("expired queued requests never execute and disposal releases queued admission", async () => {
  await withRuntime(async (runtime) => {
    expiredRequests.add(30);
    runtime.pushHostHttpRequest(0, 30, encodeRequest("GET", "/status"));
    runtime.pushHostHttpRequest(0, 31, encodeRequest("GET", "/status"));
    await settle(runtime);
    expect(replies.has(30)).toBe(false);
    expect(discardedRequests.has(30)).toBe(true);
    expect(replies.get(31)?.body).toBe('{"hits":"1","name":null}');
    runtime.pushHostHttpRequest(0, 32, encodeRequest("GET", "/status"));
    await runtime.stop();
    expect(discardedRequests.has(32)).toBe(true);
  });
});

void [StatusHandler, EchoHandler, ForbiddenHandler, BoomHandler, InvalidResponseHandler];

test("an executing request retains admission after caller timeout until its real completion", async () => {
  await withRuntime(async (runtime) => {
    runtime.pushHostHttpRequest(0, 40, encodeRequest("POST", "/hold"));
    await settle(runtime);
    expect(finishHeldRequest).toBeTypeOf("function");
    expiredRequests.add(40);
    delivered = false;
    await settle(runtime);
    expect(discardedRequests.has(40)).toBe(false);
    expect(replies.has(40)).toBe(false);
    finishHeldRequest!();
    await settle(runtime);
    expect(replies.get(40)?.status).toBe(200);
    expect(discardedRequests.has(40)).toBe(true);
  });
});
void HeldHandler;
