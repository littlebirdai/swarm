import { scenario } from "../dsl";
import {
  check,
  complete,
  observe,
  permitOf,
  refresh,
  send,
  withMultiplayerSession,
} from "../multiplayer-steps";

scenario(
  { name: "multiplayerTwoSenders" },
  withMultiplayerSession(async (world, session) => {
    const compete = async (person: "ana" | "ben") => {
      await session.join(person);
      const result = await session.submit(send(person, person, null));
      await refresh(session, person);
      return result;
    };
    const [ana, ben] = await observe(
      world,
      Promise.all([compete("ana"), compete("ben")]),
    );
    const first = typeof ana === "object" ? "ana" : "ben";
    const second = first === "ana" ? "ben" : "ana";
    const started = permitOf(first === "ana" ? ana : ben);
    check(
      world,
      "secondSendQueues",
      "The other sender queues",
      first === "ana" ? ben : ana,
      "queued",
    );

    const submitWinner = async () => {
      await session.receivePermit(started);
      const hand = await session.hand(started);
      if (hand !== "handed") return hand;
      await Promise.all([session.land(started), session.land(started)]);
      await session.publishTurn();
      return session.settle(started, "delivered");
    };
    const [outcome, oldView] = await observe(
      world,
      Promise.all([submitWinner(), refresh(session, second)]),
    );
    check(
      world,
      "firstDeliveryOutcome",
      "The first send settles as delivered",
      outcome,
      "delivered",
    );

    const [firstView, secondUnsynced] = await observe(
      world,
      Promise.all([
        refresh(session, first),
        Promise.resolve(session.view(second)),
      ]),
    );
    check(
      world,
      "independentViews",
      "One client receives the transcript before the other client",
      [firstView.transcript.length > 0, secondUnsynced, session.view(second)],
      [true, oldView, oldView],
    );
    const secondView = await observe(world, refresh(session, second));
    const firstDelivery = { id: first, from: first, turn: first, text: first };
    check(
      world,
      "firstDeliveryOnce",
      "Only the first message appears, once",
      [firstView.transcript, secondView.transcript],
      [[firstDelivery], [firstDelivery]],
    );
    check(
      world,
      "firstSenderDrives",
      "Both people see the first sender drive",
      [firstView.driver, secondView.driver],
      [first, first],
    );

    const [nonHolder, queueIntent, release] = await observe(
      world,
      Promise.all([
        session.submit(send("nonholder", second, first)),
        session.submit(send("holder-queue", first, first, "queue")),
        session.releaseQueue(),
        session.announcePresence(first),
        session.relayHeartbeat(first),
      ]),
    );
    check(
      world,
      "runningHolderOnly",
      "A non-holder cannot steer the running turn",
      nonHolder,
      "queued",
    );
    check(
      world,
      "queueWaits",
      "Queue intent waits even for the holder",
      [queueIntent, release],
      ["queued", "queued"],
    );

    const endTurn = session.machineTurn(null).then(() => session.publishTurn());
    const idle = await observe(
      world,
      endTurn.then(() => refresh(session, second)),
    );
    check(
      world,
      "idleClaim",
      "The active claim survives the end of the turn",
      [idle.driver, idle.turn, idle.presence],
      [first, null, first],
    );
    const blocked = await observe(
      world,
      session.submit(send("idle-nonholder", second, null)),
    );
    check(
      world,
      "idleHolderOnly",
      "The idle claim still belongs to the holder",
      blocked,
      "queued",
    );

    const releaseNext = async () => {
      const permit = permitOf(await session.releaseQueue());
      const released = await complete(session, permit);
      await session.publishTurn();
      return { permit, released, view: await refresh(session, first) };
    };
    const next = await observe(world, releaseNext());
    check(
      world,
      "queuedDeliveryOnce",
      "The queued send starts the next turn once",
      [next.released, next.view.transcript],
      [
        "delivered",
        [
          firstDelivery,
          { id: second, from: second, turn: second, text: second },
        ],
      ],
    );

    const legacy = await observe(
      world,
      session
        .submit(send("legacy", first, undefined))
        .then((result) =>
          typeof result === "string"
            ? result
            : complete(session, result.permit),
        ),
    );
    check(
      world,
      "optionalExpected",
      "A sender without expected still reaches the agent",
      legacy,
      "delivered",
    );
  }),
);
