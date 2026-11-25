import { scenario } from "../dsl";
import { fakeMultiplayerSession } from "../multiplayer-contract";
import {
  check,
  deliver,
  enqueue,
  handToAgent,
  sendFrom,
} from "../multiplayer-steps";

scenario({ name: "multiplayerRelayStops" }, async (world) => {
  const session = fakeMultiplayerSession(Date.now);
  session.join("ana");
  session.join("ben");
  sendFrom(session, "opening", "ben", null);
  handToAgent(session, "opening");
  session.publishTurn();
  session.relayHeartbeat("ben");
  check(
    world,
    "presenceBeforeOutage",
    "The relay shows Ben's presence before the outage",
    session.view("ana").presence,
    "ben",
  );

  await deliver(world, "relay", "The relay stops during Ben's turn", () =>
    session.killRelay(),
  );
  enqueue(
    world,
    "relay",
    "A late heartbeat from Ana cannot revive the stopped relay",
    () => session.relayHeartbeat("ana"),
  );
  enqueue(world, "ana", "Ana presses Enter while the relay is down", () =>
    sendFrom(session, "ana-queued", "ana", "opening"),
  );
  enqueue(world, "ben", "Ben presses Enter while the relay is down", () => {
    sendFrom(session, "ben-steer", "ben", "opening");
    handToAgent(session, "ben-steer");
  });
  await world.net.drain();
  const outage = session.view("ana");
  check(
    world,
    "durableDriver",
    "Both people still see Ben drive without presence",
    [outage.driver, session.view("ben").driver, outage.presence],
    ["ben", "ben", null],
  );
  check(
    world,
    "outageQueue",
    "Ana's send is queued and Ben's steer is delivered",
    [
      outage.messages.find(({ id }) => id === "ana-queued")?.state,
      outage.messages.find(({ id }) => id === "ben-steer")?.state,
    ],
    ["queued", "delivered"],
  );

  await deliver(
    world,
    "server",
    "The server starts a steer for the turn that Ben sees",
    () => {
      sendFrom(
        session,
        "stale-at-machine",
        "ben",
        "opening",
        "Use the current draft",
      );
    },
  );
  await deliver(
    world,
    "machine",
    "The machine starts a later turn before the old permit arrives",
    () => {
      session.machineTurn("next-turn");
      session.hand("stale-at-machine");
      session.land("stale-at-machine");
      session.settleDelivery("stale-at-machine");
    },
  );
  const stale = session.view("ben");
  check(
    world,
    "machineRefusesStaleSteer",
    "A steer for the previous turn is refused and stays in Ben's composer",
    {
      state: stale.messages.find(({ id }) => id === "stale-at-machine")?.state,
      composer: stale.composer,
    },
    {
      state: "stale",
      composer: { text: "Use the current draft", offerQueue: true },
    },
  );

  await deliver(
    world,
    "server",
    "The server learns the new turn before Ana's old steer arrives",
    () => {
      session.publishTurn();
      sendFrom(session, "stale-at-server", "ana", "opening", "Keep this draft");
    },
  );
  check(
    world,
    "serverRefusesStaleSteer",
    "Ana keeps the draft when the server already knows the turn ended",
    {
      state: session.view("ana").messages.at(-1)?.state,
      composer: session.view("ana").composer,
    },
    { state: "stale", composer: { text: "Keep this draft", offerQueue: true } },
  );

  await deliver(
    world,
    "machine",
    "The new turn ends and Ana's saved send starts",
    () => {
      session.machineTurn(null);
      session.publishTurn();
      session.releaseQueue();
      handToAgent(session, "ana-queued");
    },
  );
  check(
    world,
    "deliveryWithoutRelay",
    "The relay outage loses no accepted send and delivers neither stale steer",
    session.view("ana").transcript,
    [
      { id: "opening", from: "ben", turn: "opening", text: "opening" },
      { id: "ben-steer", from: "ben", turn: "opening", text: "ben-steer" },
      { id: "ana-queued", from: "ana", turn: "ana-queued", text: "ana-queued" },
    ],
  );
});
