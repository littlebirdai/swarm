import { scenario } from "../dsl";
import { fakeMultiplayerSession } from "../multiplayer-contract";
import {
  check,
  deliver,
  enqueue,
  handToAgent,
  sendFrom,
} from "../multiplayer-steps";

scenario({ name: "multiplayerOwnerTakeover" }, async (world) => {
  const session = fakeMultiplayerSession(Date.now);
  session.join("ana");
  session.join("ben");
  sendFrom(session, "opening", "ben", null);
  handToAgent(session, "opening");
  session.publishTurn();
  sendFrom(session, "in-flight", "ben", "opening");
  session.hand("in-flight");

  await deliver(
    world,
    "ana",
    "Ana asks to take over while Ben's steer is handed to the agent",
    () => {
      session.requestTakeover();
    },
  );
  check(
    world,
    "takeoverWaits",
    "Ana sees Taking over and Ben still drives",
    { driver: session.view("ana").driver, action: session.view("ana").action },
    { driver: "ben", action: "Taking over" },
  );

  enqueue(world, "ana", "Ana presses Enter while the machine drains", () => {
    sendFrom(session, "owner-queued", "ana", "opening");
  });
  enqueue(world, "ben", "Ben presses Enter while the machine drains", () => {
    sendFrom(session, "old-holder-queued", "ben", "opening");
  });
  enqueue(
    world,
    "machine",
    "The machine receives the fence and tries to acknowledge it",
    () => {
      session.receiveFence();
      session.acknowledgeFence();
    },
  );
  await world.net.drain();
  const waiting = session.view("ben");
  check(
    world,
    "fenceWaits",
    "A fence cannot finish the takeover while a handed steer is open",
    waiting.action,
    "Taking over",
  );
  check(
    world,
    "takeoverQueues",
    "Both new sends remain queued",
    waiting.messages.slice(2).map((entry) => entry.state),
    ["queued", "queued"],
  );

  await deliver(
    world,
    "machine",
    "Ben's handed steer reaches the agent before the takeover completes",
    () => {
      session.land("in-flight");
    },
  );
  check(
    world,
    "steerDrains",
    "Ben's steer lands once while Ben still drives",
    {
      driver: session.view("ana").driver,
      transcript: session.view("ana").transcript,
    },
    {
      driver: "ben",
      transcript: [
        { id: "opening", from: "ben", turn: "opening", text: "opening" },
        { id: "in-flight", from: "ben", turn: "opening", text: "in-flight" },
      ],
    },
  );
  await deliver(world, "server", "The machine reports settlement", () => {
    session.settleDelivery("in-flight");
  });
  check(
    world,
    "ownerNowDrives",
    "Both people see Ana drive after settlement",
    [session.view("ana").driver, session.view("ben").driver],
    ["ana", "ana"],
  );

  const beforeHand = fakeMultiplayerSession(Date.now);
  beforeHand.join("ana");
  beforeHand.join("ben");
  sendFrom(beforeHand, "opening", "ben", null);
  handToAgent(beforeHand, "opening");
  beforeHand.publishTurn();
  sendFrom(beforeHand, "fenced", "ben", "opening");
  beforeHand.requestTakeover();
  await deliver(
    world,
    "machine",
    "The fence arrives before the machine hands over the old steer",
    () => {
      beforeHand.receiveFence();
      beforeHand.hand("fenced");
      beforeHand.acknowledgeFence();
      beforeHand.land("fenced");
    },
  );
  const fenced = beforeHand.view("ana");
  check(
    world,
    "fenceBlocksHand",
    "The fenced steer remains queued and Ana takes over after acknowledgement",
    {
      driver: fenced.driver,
      messages: fenced.messages,
      transcript: fenced.transcript.map(({ id }) => id),
    },
    {
      driver: "ana",
      messages: [
        { id: "opening", state: "delivered" },
        { id: "fenced", state: "queued" },
      ],
      transcript: ["opening"],
    },
  );
});
