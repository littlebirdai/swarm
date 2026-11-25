import { scenario } from "../dsl";
import { fakeMultiplayerSession } from "../multiplayer-contract";
import {
  check,
  deliver,
  enqueue,
  handToAgent,
  sendFrom,
} from "../multiplayer-steps";

scenario({ name: "multiplayerTwoSenders" }, async (world) => {
  const session = fakeMultiplayerSession(Date.now);
  session.join("ana");
  session.join("ben");

  const arrival: ("ana" | "ben")[] = [];
  for (const person of ["ana", "ben"] as const) {
    enqueue(world, person, `${person} presses Enter on an idle session`, () => {
      arrival.push(person);
      sendFrom(session, person, person, null);
    });
  }
  await world.net.drain();
  const [first, second] = arrival;
  check(
    world,
    "firstSenderDrives",
    "Both people see the first sender drive",
    [session.view(first).driver, session.view(second).driver],
    [first, first],
  );
  check(
    world,
    "secondSendQueues",
    "The other send waits in the shared queue",
    session.view(second).messages,
    [
      { id: first, state: "waiting" },
      { id: second, state: "queued" },
    ],
  );

  await deliver(
    world,
    "machine",
    "The hand-over is delivered and retried",
    () => {
      session.hand(first);
      session.land(first);
      session.land(first);
      session.settleDelivery(first);
      session.publishTurn();
    },
  );
  await deliver(
    world,
    "server",
    "The queue cannot enter the running turn",
    () => {
      session.releaseQueue();
      handToAgent(session, second);
    },
  );
  const firstDelivery = { id: first, from: first, turn: first, text: first };
  check(
    world,
    "firstDeliveryOnce",
    "Only the first send reaches the running turn, once",
    session.view(second).transcript,
    [firstDelivery],
  );

  await deliver(
    world,
    "server",
    "The turn ends and the queued send starts the next turn",
    () => {
      session.machineTurn(null);
      session.publishTurn();
      session.releaseQueue();
      handToAgent(session, second);
    },
  );
  check(
    world,
    "queuedDeliveryOnce",
    "Both sends appear once and in order",
    session.view(first).transcript,
    [firstDelivery, { id: second, from: second, turn: second, text: second }],
  );
});
