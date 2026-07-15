import net from "node:net";
import { readU16BE } from "../app/core/protocol/binary";
import {
  encodePacket,
  LengthPrefixedFrameDecoder,
} from "../app/core/protocol/frame";
import {
  C2S_MailboxParityCodec,
  S2C_MailboxParityCodec,
} from "../app/generated/model/client/bench/protocol/messages";
import { MailboxParityProtocol } from "../app/generated/model/client/bench/protocol/rpcs";

void main();

async function main(): Promise<void> {
  const rpcId = 1;
  const packet = encodePacket(
    MailboxParityProtocol.MailboxParity.requestCode,
    C2S_MailboxParityCodec.encode({
      rpcId,
      callCount: 8,
      delayMs: 50,
    }),
  );
  const frame = await requestOne("127.0.0.1", 7410, packet);
  const msgcode = readU16BE(frame);
  if (msgcode !== MailboxParityProtocol.MailboxParity.responseCode) {
    throw new Error(`unexpected response msgcode: ${msgcode}`);
  }

  const response = S2C_MailboxParityCodec.decode(frame.subarray(2));
  if (response.rpcId !== rpcId || response.error) {
    throw new Error(`mailbox parity RPC failed: ${JSON.stringify(response)}`);
  }
  if (response.maxServerConcurrency < 2) {
    throw new Error(
      `unordered target was serialized: ${JSON.stringify(response)}`,
    );
  }
  console.log("mailbox parity passed:", response);
}

function requestOne(
  ip: string,
  port: number,
  packet: Uint8Array,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    const decoder = new LengthPrefixedFrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("mailbox parity request timed out"));
    }, 5000);

    socket.on("connect", () => socket.write(Buffer.from(packet)));
    socket.on("data", (chunk: Buffer) => {
      try {
        const frame = decoder.push(chunk)[0];
        if (!frame) return;
        clearTimeout(timer);
        socket.end();
        resolve(frame);
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
