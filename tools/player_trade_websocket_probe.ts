import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import type {
  G2C_PlayerTradeChanged,
  G2C_PlayerTradeClosed,
  G2C_PlayerTradeInvite,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";
import {
  GateClient,
  MapClient,
} from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";

const HOST = process.env.TIANGZ_LOGIN_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TIANGZ_LOGIN_PORT ?? 7_000);

async function main(): Promise<void> {
  const suffix = Date.now();
  const requesterAccount = `trade_ws_a_${suffix}`;
  const targetAccount = `trade_ws_b_${suffix}`;
  const password = "trade_probe_password";
  const requesterFlow = new LoginFlow({ transport: "websocket", host: HOST, port: PORT });
  const targetFlow = new LoginFlow({ transport: "websocket", host: HOST, port: PORT });
  const updates = setInterval(() => {
    requesterFlow.update();
    targetFlow.update();
  }, 1);

  try {
    const [requesterRegistration, targetRegistration] = await Promise.all([
      requesterFlow.register(requesterAccount, password),
      targetFlow.register(targetAccount, password),
    ]);
    if (!requesterRegistration.character || !targetRegistration.character) {
      throw new Error("player trade probe registration did not create both characters");
    }

    const requester = await requesterFlow.enterGame(
      requesterAccount,
      password,
      1,
      undefined,
      requesterRegistration.character.characterId,
    );
    const target = await targetFlow.enterGame(
      targetAccount,
      password,
      1,
      undefined,
      targetRegistration.character.characterId,
    );
    await Promise.all([
      new GateClient(requester.gateSocket).mapSnapshotReady({ unitId: requester.enterMap.unitId }),
      new GateClient(target.gateSocket).mapSnapshotReady({ unitId: target.enterMap.unitId }),
    ]);

    let requesterReceivedInvite = false;
    const unsubscribeRequesterInvite = requester.gateSocket.on<G2C_PlayerTradeInvite>(
      ClientMessages.PlayerTradeInvite,
      () => {
        requesterReceivedInvite = true;
      },
    );
    const invitePromise = target.gateSocket.waitForMessage<G2C_PlayerTradeInvite>(
      ClientMessages.PlayerTradeInvite,
      { timeoutMs: 5_000 },
    );
    const requested = await new MapClient(requester.gateSocket).requestPlayerTrade({
      targetUnitId: target.enterMap.unitId,
    });
    const invite = await invitePromise;
    if (invite.trade.tradeId !== requested.trade.tradeId) {
      throw new Error(`trade invite id mismatch: ${invite.trade.tradeId} != ${requested.trade.tradeId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribeRequesterInvite();
    if (requesterReceivedInvite) {
      throw new Error("player trade requester incorrectly received the target-only invite push");
    }

    const requesterChanged = requester.gateSocket.waitForMessage<G2C_PlayerTradeChanged>(
      ClientMessages.PlayerTradeChanged,
      { timeoutMs: 5_000 },
    );
    const targetChanged = target.gateSocket.waitForMessage<G2C_PlayerTradeChanged>(
      ClientMessages.PlayerTradeChanged,
      { timeoutMs: 5_000 },
    );
    const accepted = await new MapClient(target.gateSocket).respondPlayerTrade({
      tradeId: invite.trade.tradeId,
      accept: true,
    });
    const [requesterOpen, targetOpen] = await Promise.all([requesterChanged, targetChanged]);
    if (
      accepted.trade.phase !== 2 ||
      requesterOpen.trade.phase !== 2 ||
      targetOpen.trade.phase !== 2
    ) {
      throw new Error("accepted player trade did not publish the open phase to both clients");
    }

    const requesterClosed = requester.gateSocket.waitForMessage<G2C_PlayerTradeClosed>(
      ClientMessages.PlayerTradeClosed,
      { timeoutMs: 5_000 },
    );
    const targetClosed = target.gateSocket.waitForMessage<G2C_PlayerTradeClosed>(
      ClientMessages.PlayerTradeClosed,
      { timeoutMs: 5_000 },
    );
    await new MapClient(requester.gateSocket).cancelPlayerTrade({ tradeId: invite.trade.tradeId });
    const [requesterClose, targetClose] = await Promise.all([requesterClosed, targetClosed]);
    if (requesterClose.committed || targetClose.committed) {
      throw new Error("cancelled player trade was incorrectly reported as committed");
    }

    console.log("Player trade WebSocket probe passed", {
      requesterUnitId: requester.enterMap.unitId,
      targetUnitId: target.enterMap.unitId,
      tradeId: invite.trade.tradeId,
    });
  } finally {
    clearInterval(updates);
    requesterFlow.close();
    targetFlow.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
