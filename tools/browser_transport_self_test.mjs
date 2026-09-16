import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { createServer } from "node:net";

const root = path.resolve(import.meta.dirname, "..");
const bundle = await build({ entryPoints: [path.join(root, "client_sdk/typescript/Core/Net/BrowserWebSocketTransport.ts")], write: false, bundle: true, platform: "node", format: "cjs", external: ["./ClientTransport"] });
function harness() {
  const sockets = [];
  const state = { failConstructor: false };
  class FakeWebSocket {
    readyState = 0; closeCalls = 0; sent = [];
    constructor(url) { if (state.failConstructor) throw new Error("invalid endpoint"); this.url = url; sockets.push(this); }
    close() { this.closeCalls++; this.readyState = 3; }
    send(frame) { this.sent.push(frame); }
    opened() { this.readyState = 1; this.onopen?.(); }
    closed() { this.readyState = 3; this.onclose?.(); }
  }
  let factory;
  const exports = {};
  runInNewContext(bundle.outputFiles[0].text, { exports, module: { exports }, WebSocket: FakeWebSocket, ArrayBuffer, Uint8Array,
    require: () => ({ registerClientTransport: (_name, value) => { factory = value; }, formatEndpoint: endpoint => `${endpoint.transport}://${endpoint.host}:${endpoint.port}` }) });
  return { sockets, state, transport: factory({ transport: "websocket", host: "127.0.0.1", port: 19001 }) };
}

{
  const { sockets, transport } = harness();
  const pending = transport.connect();
  assert.equal(transport.connect(), pending, "concurrent connect must share its pending handshake");
  const rejection = assert.rejects(pending, /关闭|取消/);
  transport.close();
  assert.equal(sockets[0].closeCalls, 1, "close during handshake must close the actual pending WebSocket");
  await rejection;
  sockets[0].opened();
  assert.equal(transport.connected, false, "late open after close must not revive transport");
}
{
  const { sockets, transport } = harness();
  const messages = []; const closes = [];
  transport.setListener({ onMessage: message => messages.push(message), onClose: error => closes.push(error) });
  const first = transport.connect();
  const rejected = assert.rejects(first, /连接失败/);
  sockets[0].onerror();
  await rejected;
  const retry = transport.connect();
  assert.equal(sockets.length, 2);
  sockets[0].closed(); sockets[0].opened();
  assert.equal(transport.connected, false, "stale callbacks must not attach the failed socket");
  sockets[1].opened(); await retry;
  assert.equal(transport.connected, true);
  const oldCloseCount = closes.length;
  sockets[0].closed(); sockets[0].onmessage?.({ data: new ArrayBuffer(1) });
  assert.equal(closes.length, oldCloseCount);
  assert.equal(messages.length, 0);
  transport.send(new Uint8Array([1, 2]));
  assert.equal(sockets[1].sent.length, 1);
  sockets[1].onmessage({ data: new Uint8Array([3]).buffer });
  assert.equal(messages[0][0], 3);
  sockets[1].closed();
  assert.equal(transport.connected, false);
  assert.equal(closes.length, oldCloseCount + 1);
}
{
  const { sockets, transport, state } = harness();
  state.failConstructor = true;
  await assert.rejects(transport.connect(), /invalid endpoint/);
  state.failConstructor = false;
  const retry = transport.connect();
  assert.equal(sockets.length, 1, "constructor failure must not cache a permanently rejected handshake");
  sockets[0].opened(); await retry; transport.close();
}
console.log("browser transport lifecycle passed: connecting cancellation, failed handshake retry, stale callbacks and constructor failure");

// Exercise Node's real WebSocket against a TCP server that deliberately never completes the handshake.
const liveBundle = await build({ stdin: { contents: 'import "./client_sdk/typescript/Core/Net/BrowserWebSocketTransport"; export { createClientTransport } from "./client_sdk/typescript/Core/Net/ClientTransport";', resolveDir: root, sourcefile: "transport-probe.ts", loader: "ts" }, write: false, bundle: true, platform: "node", format: "esm" });
const { createClientTransport } = await import(`data:text/javascript;base64,${Buffer.from(liveBundle.outputFiles[0].text).toString("base64")}`);
const peers = new Set();
let accepted;
const received = new Promise(resolve => { accepted = resolve; });
const server = createServer(peer => { peers.add(peer); peer.on("error", () => {}); peer.once("data", () => accepted(peer)); });
let transport;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  transport = createClientTransport({ transport: "websocket", host: "127.0.0.1", port: server.address().port });
  const connected = transport.connect();
  const rejected = assert.rejects(connected, /关闭/);
  const peer = await bounded(received);
  const closed = new Promise(resolve => peer.once("close", resolve));
  transport.close();
  await bounded(rejected);
  await bounded(closed);
  assert.equal(transport.connected, false);
  console.log("real WebSocket cancellation passed: pending handshake rejected and TCP connection closed");
} finally {
  transport?.close();
  for (const peer of peers) peer.destroy();
  await new Promise(resolve => server.close(resolve));
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("WebSocket cancellation timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}
