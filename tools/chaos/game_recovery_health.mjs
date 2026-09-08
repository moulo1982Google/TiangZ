export function evaluateHealth(shard, result, options) {
  const issues = [];
  if (result.players !== shard.players) {
    issues.push(`players=${result.players}, expected=${shard.players}`);
  }
  if (result.targetMapId !== shard.mapId) {
    issues.push(`targetMapId=${result.targetMapId}, expected=${shard.mapId}`);
  }
  const placements = result.playerPlacements;
  const identities = playerIdentities(placements, shard.players);
  if (!identities) issues.push("missing or invalid original-character evidence");
  if (result.accountMode !== "stable-reuse") issues.push("accounts are not stable-reuse");
  if (result.setup?.count !== shard.players) issues.push("not all players completed setup");
  for (const placement of Array.isArray(placements) ? placements : []) {
    if (!placement) { issues.push("missing player placement"); break; }
    const expectedMode = placement.mapId === shard.mapId ? shard.spatialMode
      : placement.mapId === options.safeMapId ? "grid2d" : undefined;
    if (!expectedMode || placement.spatialMode !== expectedMode || String(placement.mapInstanceId) !== String(placement.mapId)) {
      issues.push("player entered a disallowed map, instance or spatial mode"); break;
    }
  }
  if (options.moveRate > 0) {
    const sent = Number(result.movement?.count ?? 0);
    const acknowledged = Number(result.movement?.acknowledged ?? 0);
    if (sent <= 0) issues.push("movement sent no measured requests");
    if (Number(result.movement?.errors ?? 0) !== 0) {
      issues.push(`movement.errors=${result.movement?.errors}`);
    }
    if (sent > 0 && acknowledged / sent < 0.99) {
      issues.push(`movement acknowledgement ratio=${(acknowledged / sent).toFixed(4)}`);
    }
    if (Number(result.movement?.entityMovePushes ?? 0) <= 0) {
      issues.push("movement received no authoritative pushes");
    }
  }
  if (options.probeRate > 0) {
    if (Number(result.probe?.count ?? 0) <= 0) issues.push("probe sent no measured requests");
    if (Number(result.probe?.errors ?? 0) !== 0) {
      issues.push(`probe.errors=${result.probe?.errors}`);
    }
  }
  if (options.businessRate > 0) {
    if (Number(result.business?.count ?? 0) <= 0) {
      issues.push("business sent no measured requests");
    }
    if (Number(result.business?.transportErrors ?? 0) !== 0) {
      issues.push(`business.transportErrors=${result.business?.transportErrors}`);
    }
  }
  return issues;
}

export function playerIdentities(placements, players) {
  if (!Array.isArray(placements) || placements.length !== players) return undefined;
  if (placements.some(p => !p || typeof p !== "object")) return undefined;
  const sorted = [...placements].sort((a,b)=>a.playerIndex-b.playerIndex);
  if (sorted.some((p,i)=>!p || p.playerIndex!==i || typeof p.characterId !== "string" || !/^[1-9][0-9]*$/.test(p.characterId))) return undefined;
  if (new Set(sorted.map(p=>p.characterId)).size !== players) return undefined;
  return JSON.stringify(sorted.map(p=>p.characterId));
}
