import { readU16BE } from "../../core/protocol/binary";
import { encodePacket } from "../../core/protocol/frame";
import {
  C2S_GetLoginServiceAddrCodec,
  C2G_EnterMap,
  C2G_EnterMapCodec,
  C2G_LoginGate,
  C2G_LoginGateCodec,
  C2M_Move,
  C2M_MoveCodec,
  C2M_MapProbe,
  C2M_MapProbeCodec,
  C2S_Login,
  C2S_LoginCodec,
  G2C_EnterMap,
  G2C_EnterMapCodec,
  G2C_LoginGate,
  G2C_LoginGateCodec,
  G2C_MapReady,
  G2C_MapReadyCodec,
  M2C_MapProbe,
  M2C_MapProbeCodec,
  G2C_EntityMove,
  G2C_EntityMoveCodec,
  G2C_EntityEnter,
  G2C_EntityEnterCodec,
  G2C_EntityLeave,
  G2C_EntityLeaveCodec,
  S2C_GetLoginServiceAddr,
  S2C_GetLoginServiceAddrCodec,
  S2C_Login,
  S2C_LoginCodec,
} from "../../generated/model/client/demo/protocol/messages";
import { MsgCode } from "../../generated/model/client/demo/protocol/msgcodes";

export interface DecodedFrame<T> {
  msgcode: number;
  rpcId: number | undefined;
  body: T;
}

export function buildGetLoginServiceAddrPacket(rpcId: number): Uint8Array {
  return encodePacket(
    MsgCode.C2S_GetLoginServiceAddr,
    C2S_GetLoginServiceAddrCodec.encode({ rpcId }),
  );
}

export function decodeGetLoginServiceAddrFrame(
  frame: Uint8Array,
): DecodedFrame<S2C_GetLoginServiceAddr> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.S2C_GetLoginServiceAddr) {
    throw new Error(`expected S2C_GetLoginServiceAddr, got ${msgcode}`);
  }
  const body = S2C_GetLoginServiceAddrCodec.decode(frame.subarray(2));
  return {
    msgcode,
    rpcId: body.rpcId,
    body,
  };
}

export function buildLoginPacket(rpcId: number, request: C2S_Login): Uint8Array {
  return encodePacket(
    MsgCode.C2S_Login,
    C2S_LoginCodec.encode({ ...request, rpcId }),
  );
}

export function decodeLoginFrame(frame: Uint8Array): DecodedFrame<S2C_Login> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.S2C_Login) {
    throw new Error(`expected S2C_Login, got ${msgcode}`);
  }
  const body = S2C_LoginCodec.decode(frame.subarray(2));
  return {
    msgcode,
    rpcId: body.rpcId,
    body,
  };
}

export function buildEnterMapPacket(
  rpcId: number,
  request: C2G_EnterMap,
): Uint8Array {
  return encodePacket(
    MsgCode.C2G_EnterMap,
    C2G_EnterMapCodec.encode({ ...request, rpcId }),
  );
}

export function buildLoginGatePacket(
  rpcId: number,
  request: C2G_LoginGate,
): Uint8Array {
  return encodePacket(
    MsgCode.C2G_LoginGate,
    C2G_LoginGateCodec.encode({ ...request, rpcId }),
  );
}

export function decodeLoginGateFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_LoginGate> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_LoginGate) {
    throw new Error(`expected G2C_LoginGate, got ${msgcode}`);
  }
  const body = G2C_LoginGateCodec.decode(frame.subarray(2));
  return {
    msgcode,
    rpcId: body.rpcId,
    body,
  };
}

export function decodeEnterMapFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EnterMap> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EnterMap) {
    throw new Error(`expected G2C_EnterMap, got ${msgcode}`);
  }
  const body = G2C_EnterMapCodec.decode(frame.subarray(2));
  return {
    msgcode,
    rpcId: body.rpcId,
    body,
  };
}

export function decodeMapReadyFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_MapReady> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_MapReady) {
    throw new Error(`expected G2C_MapReady, got ${msgcode}`);
  }
  const body = G2C_MapReadyCodec.decode(frame.subarray(2));
  return {
    msgcode,
    rpcId: undefined,
    body,
  };
}

export function buildMovePacket(request: C2M_Move): Uint8Array {
  return encodePacket(MsgCode.C2M_Move, C2M_MoveCodec.encode(request));
}

export function buildMapProbePacket(
  rpcId: number,
  request: C2M_MapProbe,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_MapProbe,
    C2M_MapProbeCodec.encode({ ...request, rpcId }),
  );
}

export function decodeMapProbeFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_MapProbe> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_MapProbe) {
    throw new Error(`expected M2C_MapProbe, got ${msgcode}`);
  }
  const body = M2C_MapProbeCodec.decode(frame.subarray(2));
  return {
    msgcode,
    rpcId: body.rpcId,
    body,
  };
}

export function decodeEntityMoveFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EntityMove> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EntityMove) {
    throw new Error(`expected G2C_EntityMove, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_EntityMoveCodec.decode(frame.subarray(2)),
  };
}

export function decodeEntityEnterFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EntityEnter> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EntityEnter) {
    throw new Error(`expected G2C_EntityEnter, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_EntityEnterCodec.decode(frame.subarray(2)),
  };
}

export function decodeEntityLeaveFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EntityLeave> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EntityLeave) {
    throw new Error(`expected G2C_EntityLeave, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_EntityLeaveCodec.decode(frame.subarray(2)),
  };
}
