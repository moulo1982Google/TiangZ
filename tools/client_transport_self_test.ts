import {
  type ClientTransport,
  UnsupportedTransportError,
  createClientTransport,
  registerClientTransport,
} from "../cocos_client2D/assets/scripts/Core/Net/ClientTransport";

function expectUnsupported(transport: "tcp" | "kcp"): void {
  try {
    createClientTransport({ transport, host: "127.0.0.1", port: 7000 });
    throw new Error(`${transport} should be unsupported without a native adapter`);
  } catch (error) {
    if (!(error instanceof UnsupportedTransportError)) throw error;
  }
}

expectUnsupported("tcp");
expectUnsupported("kcp");

const unregister = registerClientTransport("kcp", (endpoint) => {
  const transport: ClientTransport = {
    endpoint,
    connected: false,
    connect: async () => {},
    send: () => {},
    close: () => {},
    setListener: () => {},
  };
  return transport;
});
const registered = createClientTransport({
  transport: "kcp",
  host: "127.0.0.1",
  port: 7000,
});
if (registered.endpoint.transport !== "kcp") {
  throw new Error("registered KCP adapter was not selected");
}
unregister();
expectUnsupported("kcp");

console.log("client transport self-test passed");
