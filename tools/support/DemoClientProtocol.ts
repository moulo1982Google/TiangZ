import { encodePacket, readU16BE } from "../../app/core/public";
import {
  C2S_GetLoginServiceAddrCodec,
  C2G_EnterMap,
  C2G_EnterMapCodec,
  C2G_MapSnapshotReady,
  C2G_MapSnapshotReadyCodec,
  C2G_LoginGate,
  C2G_LoginGateCodec,
  C2G_PingCodec,
  C2M_Move,
  C2M_MoveCodec,
  C2M_AttackMonster,
  C2M_AttackMonsterCodec,
  C2M_ToggleAutoAttack,
  C2M_ToggleAutoAttackCodec,
  C2M_CastSkill,
  C2M_CastSkillCodec,
  C2M_MapProbe,
  C2M_MapProbeCodec,
  C2M_FindPath,
  C2M_FindPathCodec,
  C2M_NavigateTo,
  C2M_NavigateToCodec,
  C2M_NavigateInput,
  C2M_NavigateInputCodec,
  C2M_ToggleDemoDoor,
  C2M_ToggleDemoDoorCodec,
  C2M_UseItem,
  C2M_UseItemCodec,
  C2M_CompleteQuest,
  C2M_CompleteQuestCodec,
  C2S_Login,
  C2S_LoginCodec,
  G2C_EnterMap,
  G2C_EnterMapCodec,
  G2C_LoginGate,
  G2C_LoginGateCodec,
  G2C_MapReady,
  G2C_MapReadyCodec,
  G2C_MapSnapshotReady,
  G2C_MapSnapshotReadyCodec,
  G2C_Ping,
  G2C_PingCodec,
  G2C_AoiDelta,
  G2C_AoiDeltaCodec,
  G2C_AutoAttackState,
  G2C_AutoAttackStateCodec,
  G2C_SkillCastState,
  G2C_SkillCastStateCodec,
  G2C_SkillImpact,
  G2C_SkillImpactCodec,
  G2C_SkillProjectile,
  G2C_SkillProjectileCodec,
  M2C_MapProbe,
  M2C_MapProbeCodec,
  M2C_AttackMonster,
  M2C_AttackMonsterCodec,
  M2C_ToggleAutoAttack,
  M2C_ToggleAutoAttackCodec,
  M2C_CastSkill,
  M2C_CastSkillCodec,
  M2C_FindPath,
  M2C_FindPathCodec,
  M2C_NavigateTo,
  M2C_NavigateToCodec,
  M2C_NavigateInput,
  M2C_NavigateInputCodec,
  M2C_ToggleDemoDoor,
  M2C_ToggleDemoDoorCodec,
  G2C_EntityMove,
  G2C_EntityMoveCodec,
  G2C_EntityNavigate,
  G2C_EntityNavigateCodec,
  G2C_EntityEnter,
  G2C_EntityEnterCodec,
  G2C_EntityLeave,
  G2C_EntityLeaveCodec,
  G2C_EntityNumeric,
  G2C_EntityNumericCodec,
  G2C_EntityState,
  G2C_EntityStateCodec,
  G2C_ItemChanged,
  G2C_ItemChangedCodec,
  M2C_UseItem,
  M2C_UseItemCodec,
  M2C_CompleteQuest,
  M2C_CompleteQuestCodec,
  S2C_GetLoginServiceAddr,
  S2C_GetLoginServiceAddrCodec,
  S2C_Login,
  S2C_LoginCodec,
} from "../../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import { MsgCode } from "../../client_sdk/typescript/Generated/Model/demo/protocol/msgcodes";

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

export function buildMapSnapshotReadyPacket(
  rpcId: number,
  request: C2G_MapSnapshotReady,
): Uint8Array {
  return encodePacket(
    MsgCode.C2G_MapSnapshotReady,
    C2G_MapSnapshotReadyCodec.encode({ ...request, rpcId }),
  );
}

export function decodeMapSnapshotReadyFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_MapSnapshotReady> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_MapSnapshotReady) {
    throw new Error(`expected G2C_MapSnapshotReady, got ${msgcode}`);
  }
  const body = G2C_MapSnapshotReadyCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function buildPingPacket(rpcId = 0): Uint8Array {
  return encodePacket(MsgCode.C2G_Ping, C2G_PingCodec.encode({ rpcId }));
}

export function decodePingFrame(frame: Uint8Array): DecodedFrame<G2C_Ping> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_Ping) {
    throw new Error(`expected G2C_Ping, got ${msgcode}`);
  }
  const body = G2C_PingCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
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

/** 构造玩家攻击怪物的测试包。 / Builds the smoke-test packet for a player attacking a monster. */
export function buildAttackMonsterPacket(
  rpcId: number,
  request: Omit<C2M_AttackMonster, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_AttackMonster,
    C2M_AttackMonsterCodec.encode({ ...request, rpcId }),
  );
}

/** 解码怪物攻击响应。 / Decodes the monster-attack response. */
export function decodeAttackMonsterFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_AttackMonster> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_AttackMonster) {
    throw new Error(`expected M2C_AttackMonster, got ${msgcode}`);
  }
  const body = M2C_AttackMonsterCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

/** 构造切换平A意图的测试包。 / Builds the auto-attack intent toggle packet for smoke tests. */
export function buildToggleAutoAttackPacket(
  rpcId: number,
  request: Omit<C2M_ToggleAutoAttack, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_ToggleAutoAttack,
    C2M_ToggleAutoAttackCodec.encode({ ...request, rpcId }),
  );
}

/** 解码平A开关响应。 / Decodes the auto-attack toggle response. */
export function decodeToggleAutoAttackFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_ToggleAutoAttack> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_ToggleAutoAttack) {
    throw new Error(`expected M2C_ToggleAutoAttack, got ${msgcode}`);
  }
  const body = M2C_ToggleAutoAttackCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

/** 解码服务端推送的当前平A状态。 / Decodes the server push carrying the current auto-attack state. */
export function decodeAutoAttackStateFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_AutoAttackState> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_AutoAttackState) {
    throw new Error(`expected G2C_AutoAttackState, got ${msgcode}`);
  }
  const body = G2C_AutoAttackStateCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: undefined, body };
}

/** 构造权威施法请求。 / Builds an authoritative skill-cast request. */
export function buildCastSkillPacket(
  rpcId: number,
  request: Omit<C2M_CastSkill, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_CastSkill,
    C2M_CastSkillCodec.encode({ ...request, rpcId }),
  );
}

export function decodeCastSkillFrame(frame: Uint8Array): DecodedFrame<M2C_CastSkill> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_CastSkill) throw new Error(`expected M2C_CastSkill, got ${msgcode}`);
  const body = M2C_CastSkillCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function decodeSkillCastStateFrame(frame: Uint8Array): DecodedFrame<G2C_SkillCastState> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_SkillCastState) throw new Error(`expected G2C_SkillCastState, got ${msgcode}`);
  return { msgcode, rpcId: undefined, body: G2C_SkillCastStateCodec.decode(frame.subarray(2)) };
}

export function decodeSkillProjectileFrame(frame: Uint8Array): DecodedFrame<G2C_SkillProjectile> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_SkillProjectile) throw new Error(`expected G2C_SkillProjectile, got ${msgcode}`);
  return { msgcode, rpcId: undefined, body: G2C_SkillProjectileCodec.decode(frame.subarray(2)) };
}

export function decodeSkillImpactFrame(frame: Uint8Array): DecodedFrame<G2C_SkillImpact> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_SkillImpact) throw new Error(`expected G2C_SkillImpact, got ${msgcode}`);
  return { msgcode, rpcId: undefined, body: G2C_SkillImpactCodec.decode(frame.subarray(2)) };
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

export function buildFindPathPacket(
  rpcId: number,
  request: Omit<C2M_FindPath, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_FindPath,
    C2M_FindPathCodec.encode({ ...request, rpcId }),
  );
}

export function decodeFindPathFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_FindPath> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_FindPath) {
    throw new Error(`expected M2C_FindPath, got ${msgcode}`);
  }
  const body = M2C_FindPathCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function buildNavigateToPacket(
  rpcId: number,
  request: Omit<C2M_NavigateTo, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_NavigateTo,
    C2M_NavigateToCodec.encode({ ...request, rpcId }),
  );
}

export function decodeNavigateToFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_NavigateTo> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_NavigateTo) {
    throw new Error(`expected M2C_NavigateTo, got ${msgcode}`);
  }
  const body = M2C_NavigateToCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function buildNavigateInputPacket(
  rpcId: number,
  request: Omit<C2M_NavigateInput, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_NavigateInput,
    C2M_NavigateInputCodec.encode({ ...request, rpcId }),
  );
}

export function decodeNavigateInputFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_NavigateInput> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_NavigateInput) {
    throw new Error(`expected M2C_NavigateInput, got ${msgcode}`);
  }
  const body = M2C_NavigateInputCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function buildToggleDemoDoorPacket(
  rpcId: number,
  request: Omit<C2M_ToggleDemoDoor, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_ToggleDemoDoor,
    C2M_ToggleDemoDoorCodec.encode({ ...request, rpcId }),
  );
}

export function decodeToggleDemoDoorFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_ToggleDemoDoor> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_ToggleDemoDoor) {
    throw new Error(`expected M2C_ToggleDemoDoor, got ${msgcode}`);
  }
  const body = M2C_ToggleDemoDoorCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function buildUseItemPacket(
  rpcId: number,
  request: C2M_UseItem,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_UseItem,
    C2M_UseItemCodec.encode({ ...request, rpcId }),
  );
}

export function decodeUseItemFrame(frame: Uint8Array): DecodedFrame<M2C_UseItem> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_UseItem) {
    throw new Error(`expected M2C_UseItem, got ${msgcode}`);
  }
  const body = M2C_UseItemCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

/** 构造任务领奖请求；关键事务的幂等语义由服务端operationId保证。 / Builds a quest claim request whose critical idempotency is owned by the server operationId. */
export function buildCompleteQuestPacket(
  rpcId: number,
  request: Omit<C2M_CompleteQuest, "rpcId">,
): Uint8Array {
  return encodePacket(
    MsgCode.C2M_CompleteQuest,
    C2M_CompleteQuestCodec.encode({ ...request, rpcId }),
  );
}

export function decodeCompleteQuestFrame(
  frame: Uint8Array,
): DecodedFrame<M2C_CompleteQuest> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.M2C_CompleteQuest) {
    throw new Error(`expected M2C_CompleteQuest, got ${msgcode}`);
  }
  const body = M2C_CompleteQuestCodec.decode(frame.subarray(2));
  return { msgcode, rpcId: body.rpcId, body };
}

export function decodeItemChangedFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_ItemChanged> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_ItemChanged) {
    throw new Error(`expected G2C_ItemChanged, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_ItemChangedCodec.decode(frame.subarray(2)),
  };
}

export function decodeEntityStateFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EntityState> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EntityState) {
    throw new Error(`expected G2C_EntityState, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_EntityStateCodec.decode(frame.subarray(2)),
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

export function decodeEntityNavigateFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EntityNavigate> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EntityNavigate) {
    throw new Error(`expected G2C_EntityNavigate, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_EntityNavigateCodec.decode(frame.subarray(2)),
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

export function decodeAoiDeltaFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_AoiDelta> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_AoiDelta) {
    throw new Error(`expected G2C_AoiDelta, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_AoiDeltaCodec.decode(frame.subarray(2)),
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

export function decodeEntityNumericFrame(
  frame: Uint8Array,
): DecodedFrame<G2C_EntityNumeric> {
  const msgcode = readU16BE(frame, 0);
  if (msgcode !== MsgCode.G2C_EntityNumeric) {
    throw new Error(`expected G2C_EntityNumeric, got ${msgcode}`);
  }
  return {
    msgcode,
    rpcId: undefined,
    body: G2C_EntityNumericCodec.decode(frame.subarray(2)),
  };
}
