import type { MaybePromise } from "../async";
import { HotfixBindingStore } from "../hotReload/HotfixSystem";
import { utf8Decode, utf8Encode } from "../protocol/binary";
import type { EntryScene } from "./types";

type SceneClass<TScene extends EntryScene> = new (...args: any[]) => TScene;

/** Scene HTTP Handler 支持的方法；OPTIONS 预检由宿主处理。 / Methods accepted by Scene HTTP handlers; the host answers OPTIONS preflight. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const HTTP_METHODS: ReadonlySet<string> = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Scene HTTP 端口收到的一个请求。头名一律小写；启用令牌鉴权时 Authorization 头已被宿主移除。
 * One request received on a Scene HTTP port. Header names are lowercase; with token auth the host
 * has already removed the Authorization header.
 */
export interface HttpRequest {
  readonly method: string;
  /** 未解码的路径，不含查询串。 / Raw path without the query string. */
  readonly path: string;
  /** 解码后的查询参数；同名参数取第一个。 / Decoded query parameters; the first value wins for repeated names. */
  readonly query: ReadonlyMap<string, string>;
  /** 小写头名；同名头以 ", " 连接。 / Lowercase header names; repeated headers are joined with ", ". */
  readonly headers: ReadonlyMap<string, string>;
  readonly remoteAddress: string;
  readonly body: Uint8Array;
  /** 按 UTF-8 解码请求体。 / Decodes the body as UTF-8. */
  text(): string;
  /** 解析 JSON 请求体；格式错误时抛出 400 的 HttpError。 / Parses a JSON body; malformed JSON throws an HttpError with status 400. */
  json<T = unknown>(): T;
}

/**
 * Handler 返回的响应。省略 status 为 200；省略 content-type 时字符串按 text/plain、字节按
 * application/octet-stream。长度、连接与跨域头由宿主管理，不能设置。
 * Response returned by a handler. Status defaults to 200; without content-type, strings are
 * text/plain and bytes application/octet-stream. Length, connection, and CORS headers are host-managed.
 */
export interface HttpResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/**
 * 在 Handler 中抛出以返回指定状态码和 `{"error": message}`；其他异常一律返回 500 且不泄露细节。
 * Throw from a handler to answer a status with `{"error": message}`; any other exception answers
 * 500 without leaking details.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** 外部 HTTP Handler 类；与 RPC Handler 一样不得持有字段，状态放在 Scene 或其 Component。 / External HTTP handler class; like RPC handlers it must not own fields, keep state on the Scene or its Components. */
export interface SceneHttpHandler<TScene extends EntryScene> {
  handle(scene: TScene, request: HttpRequest): MaybePromise<HttpResponse>;
}

type AnySceneHttpHandlerCtor = new () => SceneHttpHandler<EntryScene>;

export interface SceneHttpHandlerBinding {
  sceneCtor: Function;
  method: HttpMethod;
  path: string;
  handlerCtor: AnySceneHttpHandlerCtor;
}

const httpHandlers = new HotfixBindingStore<SceneHttpHandlerBinding>("scene-http");

/**
 * 在模块加载时为 Scene 注册一个 HTTP 路由；路径必须精确匹配，不支持参数或通配。
 * 请求进入该 Scene 的 mailbox，与协议消息遵循相同的 ordered/unordered 语义。
 *
 * Registers one HTTP route for a Scene at module load time. Paths match exactly, without
 * parameters or wildcards. Requests enter the Scene mailbox with the same ordered/unordered
 * semantics as protocol messages.
 */
export function httpHandler<TScene extends EntryScene>(
  sceneCtor: SceneClass<TScene>,
  method: HttpMethod,
  path: string,
): (handlerCtor: new () => SceneHttpHandler<TScene>) => void {
  validateRoute(method, path);
  return (handlerCtor) => {
    httpHandlers.Register(httpRouteKey(sceneCtor, method, path), {
      sceneCtor,
      method,
      path,
      handlerCtor: handlerCtor as AnySceneHttpHandlerCtor,
    });
  };
}

/** 返回 EntryScene 启动时安装的 HTTP 路由。 / Returns the HTTP routes installed during EntryScene bootstrap. */
export function getSceneHttpHandlerBindings(
  sceneCtor: Function,
): readonly SceneHttpHandlerBinding[] {
  return httpHandlers.Values().filter((binding) => binding.sceneCtor === sceneCtor);
}

/** 生成 JSON 响应；bigint 按十进制字符串输出。 / Builds a JSON response; bigint values are written as decimal strings. */
export function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(value, (_, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested),
  };
}

function validateRoute(method: string, path: string): void {
  if (!HTTP_METHODS.has(method)) {
    throw new Error(`unsupported HTTP handler method: ${method}`);
  }
  if (
    !path.startsWith("/") ||
    path.length > 1024 ||
    !/^[\x21-\x7e]+$/.test(path) ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new Error(`HTTP handler path must be an absolute path without query: ${path}`);
  }
}

function httpRouteKey(sceneCtor: Function, method: string, path: string): string {
  return `${sceneCtor.name}:${method} ${path}`;
}

interface EncodedRequestMeta {
  method: string;
  path: string;
  query: string;
  headers: [string, string][];
  remoteAddress: string;
}

/** 解码宿主请求 `[metaLen:u32 LE][meta JSON][body]`。 / Decodes the host request `[metaLen:u32 LE][meta JSON][body]`. */
export function decodeHttpRequest(payload: Uint8Array): HttpRequest {
  if (payload.length < 4) throw new Error("truncated HTTP request payload");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const metaLength = view.getUint32(0, true);
  if (4 + metaLength > payload.length) throw new Error("truncated HTTP request metadata");
  const meta = JSON.parse(utf8Decode(payload.subarray(4, 4 + metaLength))) as EncodedRequestMeta;
  const headers = new Map<string, string>();
  for (const [name, value] of meta.headers) {
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
  }
  const body = payload.subarray(4 + metaLength);
  return Object.freeze({
    method: meta.method,
    path: meta.path,
    query: parseQuery(meta.query),
    headers,
    remoteAddress: meta.remoteAddress,
    body,
    text: () => utf8Decode(body),
    json: <T>() => {
      try {
        return JSON.parse(utf8Decode(body)) as T;
      } catch {
        throw new HttpError(400, "request body is not valid JSON");
      }
    },
  });
}

function parseQuery(query: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const part of query.split("&")) {
    if (part.length === 0) continue;
    const separator = part.indexOf("=");
    const name = decodeQueryComponent(separator < 0 ? part : part.slice(0, separator));
    const value = separator < 0 ? "" : decodeQueryComponent(part.slice(separator + 1));
    if (!values.has(name)) values.set(name, value);
  }
  return values;
}

function decodeQueryComponent(value: string): string {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

interface HostHttpBridge {
  respond(requestId: number, status: number, headersJson: string, body: Uint8Array): boolean;
}

/**
 * 把响应交回宿主。返回 false 表示请求已超时或进程正在停止；响应不合法时抛错。
 * Hands a response back to the host. Returns false when the request already timed out or the
 * process is stopping; throws for an invalid response.
 */
export function sendHttpResponse(requestId: number, response: HttpResponse): boolean {
  const headers: [string, string][] = [];
  let hasContentType = false;
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    if (name.toLowerCase() === "content-type") hasContentType = true;
    headers.push([name, String(value)]);
  }
  const body = typeof response.body === "string"
    ? utf8Encode(response.body)
    : response.body ?? new Uint8Array(0);
  if (!hasContentType && body.length > 0) {
    headers.push([
      "content-type",
      typeof response.body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream",
    ]);
  }
  return hostHttp().respond(requestId, response.status ?? 200, JSON.stringify(headers), body);
}

/** 以 `{"error": message}` 回复错误状态。 / Answers an error status with `{"error": message}`. */
export function sendHttpError(requestId: number, status: number, message: string): boolean {
  return sendHttpResponse(requestId, jsonResponse({ error: message }, status));
}

function hostHttp(): HostHttpBridge {
  const bridge = (globalThis as typeof globalThis & { __hostHttp?: HostHttpBridge }).__hostHttp;
  if (!bridge) throw new Error("HTTP host bridge is not installed");
  return bridge;
}
