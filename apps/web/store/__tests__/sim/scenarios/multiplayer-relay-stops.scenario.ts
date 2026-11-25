import { scenario } from "../dsl";
import {
  check,
  complete,
  observe,
  permitOf,
  question,
  refresh,
  send,
  sendToAgent,
  withMultiplayerSession,
} from "../multiplayer-steps";

scenario(
  { name: "multiplayerRelayStops" },
  withMultiplayerSession(async (world, session) => {
    const setup = async () => {
      await Promise.all([session.join("ana"), session.join("ben")]);
      await sendToAgent(session, send("opening", "ben", null));
      await session.relayHeartbeat("ben");
      return refresh(session, "ana");
    };
    const [before] = await observe(
      world,
      Promise.all([setup(), refresh(session, "ben")]),
    );
    check(
      world,
      "presenceBeforeOutage",
      "Ana sees Ben's presence",
      before.presence,
      "ben",
    );

    const killed = session.killRelay();
    const outage = killed
      .then(() => session.relayHeartbeat("ana"))
      .then(() => refresh(session, "ana"));
    const durable = async () => {
      const prompt = question(1, "outage");
      await session.openPrompt(prompt);
      await session.publishPrompt();
      await killed;
      return refresh(session, "ben");
    };
    const [ana, ben] = await observe(world, Promise.all([outage, durable()]));
    check(
      world,
      "durableDriver",
      "Both see Ben drive through the relay outage",
      [ana.driver, ben.driver, ana.presence, ben.presence],
      ["ben", "ben", null, null],
    );
    check(
      world,
      "outagePrompt",
      "A routine prompt still names Ben while the relay is down",
      [ben.prompt?.state, ben.prompt?.canAnswer],
      ["open", "ben"],
    );

    const answerOutagePrompt = async () => {
      const result = await session.prepareAnswer("ben", ben.prompt!.expected);
      return typeof result === "string"
        ? result
        : session.deliverAnswer(result);
    };
    const sendDuringOutage = async () => {
      const [guest, owner] = await Promise.all([
        session.submit(send("ben-steer", "ben", "opening")),
        session.submit(send("ana-queued", "ana", "opening")),
      ]);
      return [await complete(session, permitOf(guest)), owner] as const;
    };
    const [answer, sends] = await observe(
      world,
      Promise.all([answerOutagePrompt(), sendDuringOutage()]),
    );
    check(
      world,
      "outageContinues",
      "The prompt, steer, and queue continue without the relay",
      [answer, ...sends],
      ["delivered", "delivered", "queued"],
    );

    const stale = async () => {
      const permit = permitOf(
        await session.submit(
          send(
            "stale-at-machine",
            "ben",
            "opening",
            "steer",
            "Use the current draft",
          ),
        ),
      );
      await session.receivePermit(permit);
      await session.machineTurn({ id: "next-turn", starter: "ben" });
      const [outcome, interrupt] = await Promise.all([
        session.hand(permit),
        session.interrupt("ana", { kind: "turn", turn: "opening" }),
      ]);
      if (outcome === "handed") await session.land(permit);
      return [
        await session.settle(
          permit,
          outcome === "handed" ? "delivered" : outcome,
        ),
        interrupt,
      ] as const;
    };
    const [[oldSteer, interrupt]] = await observe(
      world,
      Promise.all([stale(), refresh(session, "ana")]),
    );
    check(
      world,
      "machineRefusesStaleSteer",
      "The machine refuses a steer for the previous turn",
      oldSteer,
      "stale",
    );
    check(
      world,
      "interruptNoOp",
      "The machine refuses an interrupt for the previous turn",
      interrupt,
      "stale",
    );

    const serverRefuses = async () => {
      await session.publishTurn();
      const status = await session.submit(
        send("stale-at-server", "ana", "opening", "steer", "Keep this draft"),
      );
      return { status, view: await refresh(session, "ana") };
    };
    const [{ status, view }, benSynced] = await observe(
      world,
      Promise.all([serverRefuses(), refresh(session, "ben")]),
    );
    check(
      world,
      "serverRefusesStaleSteer",
      "The server refuses the stale steer and Ana keeps the draft",
      [status, view.turn, view.composer],
      ["stale", "next-turn", { text: "Keep this draft", offerQueue: true }],
    );
    check(
      world,
      "machineStaleDraft",
      "Ben keeps the text of the steer that reached the machine late",
      benSynced.composer,
      { text: "Use the current draft", offerQueue: true },
    );

    const release = async () => {
      await session.machineTurn(null);
      await session.publishTurn();
      const result = await complete(
        session,
        permitOf(await session.releaseQueue()),
      );
      return [
        result,
        (await refresh(session, "ana")).transcript.map(({ id }) => id),
      ];
    };
    const [outcome] = await observe(
      world,
      Promise.all([
        release(),
        refresh(session, "ben"),
        refresh(session, "visitor"),
      ]),
    );
    check(
      world,
      "deliveryWithoutRelay",
      "The outage loses no accepted send and delivers no stale steer",
      outcome,
      ["delivered", ["opening", "ben-steer", "ana-queued"]],
    );
  }),
);
