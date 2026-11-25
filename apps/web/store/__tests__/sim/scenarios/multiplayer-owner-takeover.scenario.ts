import {
  BATON_LEASE_MS,
  type MultiplayerSession,
} from "../multiplayer-contract";
import { scenario } from "../dsl";
import {
  check,
  complete,
  handToAgent,
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
      const hand = await handToAgent(session, permit);
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
      "steerHanded",
      "Ben's steer is open on the agent",
      hand,
      "handed",
    );

    const take = async () => {
      const fence = await session.requestTakeover();
      await session.receiveFence(fence);
      const acknowledged = await session.acknowledgeFence(fence);
      return { fence, acknowledged, view: await refresh(session, "ana") };
    };
    const [{ fence, acknowledged, view }] = await observe(
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
      [view.driver, view.action, acknowledged],
      ["ben", "Taking over", false],
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
    const [down, landed] = await observe(
      world,
      Promise.all([offline(), session.land(permit)]),
    );
    check(
      world,
      "offlineDeliveryInDoubt",
      "The driver stays while the machine is offline and the handed steer is in doubt",
      [
        down.driver,
        down.messages.find(({ id }) => id === permit.id)?.state,
        landed,
      ],
      ["ben", "in_doubt", "delivered"],
    );

    const recover = async () => {
      await session.restart();
      await session.receiveFence(fence);
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
      const outcome = await session.submit(
        send("waiting-for-machine", "ana", "opening"),
      );
      return [
        outcome,
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
      ["queued", "waiting_for_machine"],
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
      const ack = await session.acknowledgeFence(secondFence);
      return [hand, ack] as const;
    };
    const [fenced] = await observe(
      world,
      Promise.all([handAfterFence(), refresh(session, "ben")]),
    );
    check(
      world,
      "fenceBlocksHand",
      "The machine fence prevents an old permit from reaching the agent",
      fenced,
      ["queued", true],
    );
  }),
);
