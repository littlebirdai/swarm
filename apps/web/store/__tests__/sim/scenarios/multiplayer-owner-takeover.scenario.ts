import {
  BATON_LEASE_MS,
  type MultiplayerSession,
} from "../multiplayer-contract";
import { scenario } from "../dsl";
import {
  check,
  complete,
  observe,
  permitOf,
  refresh,
  send,
  sendToAgent,
  withMultiplayerSession,
} from "../multiplayer-steps";

async function openWithBen(session: MultiplayerSession) {
  await Promise.all([session.join("ana"), session.join("ben")]);
  await sendToAgent(session, send("opening", "ben", null));
}

scenario(
  { name: "multiplayerOwnerTakeover" },
  withMultiplayerSession(async (world, session) => {
    const startBen = async () => {
      await openWithBen(session);
      const permit = permitOf(
        await session.submit(send("in-flight", "ben", "opening")),
      );
      await session.receivePermit(permit);
      await session.disconnect();
      const hand = await session.hand(permit);
      await session.restart();
      return { permit, hand };
    };
    const [{ permit, hand }] = await observe(
      world,
      Promise.all([
        startBen(),
        refresh(session, "ana"),
        refresh(session, "ben"),
      ]),
    );
    check(
      world,
      "offlineMachineHandsReceivedPermit",
      "The machine can hand a permit it received before disconnecting",
      hand,
      "handed",
    );

    const forgedReceipt = await observe(
      world,
      session.settle(permit, "delivered"),
    );
    check(
      world,
      "deliveryRequiresReceipt",
      "A delivery without an agent receipt cannot settle",
      forgedReceipt,
      "refused",
    );

    const take = async () => {
      const fence = await session.requestTakeover();
      await session.receiveFence(fence);
      return { fence, view: await refresh(session, "ana") };
    };
    const [{ fence, view }] = await observe(
      world,
      Promise.all([
        take(),
        session.relayHeartbeat("ben").then(() => refresh(session, "ben")),
        session.announcePresence("ana"),
      ]),
    );
    check(
      world,
      "takeoverWaits",
      "Ana sees Taking over while Ben still drives",
      [view.driver, view.action],
      ["ben", "Taking over"],
    );

    const [anaQueued, benQueued, oldAttempt, oldFence] = await observe(
      world,
      Promise.all([
        session.submit(send("owner-queued", "ana", "opening")),
        session.submit(send("old-holder-queued", "ben", "opening")),
        session.settle(
          { ...permit, attemptId: permit.attemptId + 1 },
          "queued",
        ),
        session.settle({ ...permit, fenceId: permit.fenceId - 1 }, "queued"),
      ]),
    );
    check(
      world,
      "takeoverQueues",
      "Both new steers queue and mismatched attempts or fences cannot settle the old one",
      [anaQueued, benQueued, oldAttempt, oldFence],
      ["queued", "queued", "refused", "refused"],
    );

    const offline = async () => {
      await session.disconnect();
      return refresh(session, "ana");
    };
    const [down] = await observe(
      world,
      Promise.all([offline(), refresh(session, "ben")]),
    );
    check(
      world,
      "offlineDeliveryInDoubt",
      "The driver stays while the machine is offline and the handed steer is in doubt",
      [down.driver, down.messages.find(({ id }) => id === permit.id)?.state],
      ["ben", "in_doubt"],
    );

    const restart = async () => {
      await session.restart();
      await session.receiveFence(fence);
      const ack = await session.acknowledgeFence(fence);
      const pending = await session.reconcile(permit);
      return [ack, pending, (await refresh(session, "ana")).driver] as const;
    };
    const [ackWhileOpen] = await observe(
      world,
      Promise.all([restart(), refresh(session, "ben")]),
    );
    check(
      world,
      "ackWaitsAfterRestart",
      "The machine withholds the ack while its journal has an unlanded steer",
      ackWhileOpen,
      [false, "in_doubt", "ben"],
    );

    const recover = async () => {
      await session.land(permit);
      await session.receivePermit(permit);
      const retry = await session.hand(permit);
      const result = await session.reconcile(permit);
      return [retry, result] as const;
    };
    const [[retry, settled]] = await observe(
      world,
      Promise.all([recover(), refresh(session, "ben")]),
    );
    check(
      world,
      "restartRecoversHandedSteer",
      "Restart uses the journal and the receipt without handing the steer again",
      [retry, settled],
      ["in_doubt", "delivered"],
    );
    const gated = await observe(
      world,
      session.submit(send("before-confirmation", "ben", "opening")),
    );
    check(
      world,
      "takeoverGate",
      "The old holder cannot start another steer before the owner receives the baton",
      gated,
      "queued",
    );
    const confirmed = await observe(world, session.confirmTakeover(fence));
    check(
      world,
      "confirmTakeover",
      "The server confirms the takeover after the old steer settles",
      confirmed,
      true,
    );
    const [owner, guest] = await observe(
      world,
      Promise.all([refresh(session, "ana"), refresh(session, "ben")]),
    );
    check(
      world,
      "ownerNowDrives",
      "The owner takes over after the handed steer settles once",
      [owner.driver, guest.driver, owner.transcript.map(({ id }) => id)],
      ["ana", "ana", ["opening", "in-flight"]],
    );

    const waitForMachine = async () => {
      await session.disconnect();
      const message = send("waiting-for-machine", "ana", "opening");
      const outcome = await session.submit(message);
      const repeat = await session.submit(message);
      return [
        outcome,
        repeat,
        (await refresh(session, "ana")).messages.at(-1)?.state,
      ] as const;
    };
    const [saved] = await observe(
      world,
      Promise.all([waitForMachine(), refresh(session, "ben")]),
    );
    check(
      world,
      "offlineSendSaved",
      "A new send waits for the machine and remains visible",
      saved,
      ["queued", "queued", "waiting_for_machine"],
    );
    const resume = async () => {
      await session.restart();
      const result = await session.retryQueuedSteer(
        "waiting-for-machine",
        "ana",
        { kind: "turn", turn: "opening" },
      );
      return complete(session, permitOf(result));
    };
    const resumed = await observe(world, resume());
    check(
      world,
      "offlineSendResumes",
      "The saved send reaches the agent after reconnect",
      resumed,
      "delivered",
    );

    const handAfterFence = async () => {
      await session.elapse(BATON_LEASE_MS);
      await session.machineTurn(null);
      await session.publishTurn();
      await sendToAgent(session, send("ben-again", "ben", null));
      const next = permitOf(
        await session.submit(send("fenced", "ben", "ben-again")),
      );
      await session.receivePermit(next);

      const secondFence = await session.requestTakeover();
      await session.receiveFence(secondFence);
      const hand = await session.hand(next);
      const unhanded = await session.land(next);
      await session.disconnect();
      await session.restart();
      const ackBeforeFence = await session.acknowledgeFence(secondFence);
      await session.receiveFence(secondFence);
      const ack = await session.acknowledgeFence(secondFence);
      const requeued = await session.reconcile(next);
      const sendAfterAck = await session.submit(
        send("after-ack", "ana", "ben-again"),
      );
      const delivered =
        typeof sendAfterAck === "string"
          ? sendAfterAck
          : await complete(session, sendAfterAck.permit);
      const view = await refresh(session, "ana");
      return {
        hand,
        ack,
        driver: view.driver,
        unhanded,
        ackBeforeFence,
        requeued,
        delivered,
        view,
      };
    };
    const [fenced] = await observe(
      world,
      Promise.all([handAfterFence(), refresh(session, "ben")]),
    );
    check(
      world,
      "restartClearsFence",
      "Restart requires the fence to arrive again before the machine acknowledges it",
      fenced.ackBeforeFence,
      false,
    );
    check(
      world,
      "fenceBlocksHand",
      "The machine fence prevents an old permit from reaching the agent",
      [fenced.hand, fenced.unhanded, fenced.ack, fenced.driver],
      ["queued", "refused", true, "ana"],
    );
    check(
      world,
      "lostPermitRequeuesAndUnblocksOwner",
      "A permit lost before handoff requeues and the owner can send after the ack",
      [
        fenced.requeued,
        fenced.delivered,
        fenced.view.messages.find(({ id }) => id === "fenced")?.state,
        fenced.view.transcript.at(-1)?.id,
      ],
      ["queued", "delivered", "queued", "after-ack"],
    );
  }),
);
