import { scenario } from "../dsl";
import {
  BATON_LEASE_MS,
  fakeMultiplayerSession,
} from "../multiplayer-contract";
import {
  check,
  deliver,
  enqueue,
  handToAgent,
  sendFrom,
} from "../multiplayer-steps";

scenario({ name: "multiplayerLateJoin" }, async (world) => {
  const session = fakeMultiplayerSession(Date.now);
  const routine = {
    kind: "prompt",
    run: 1,
    prompt_id: "1",
    class: "routine",
  } as const;
  const snapshot = {
    files: ["src/notes.ts"],
    decisions: ["Keep the public signature"],
  };
  session.join("ana");
  await deliver(world, "ana", "Ana starts and steers the session alone", () => {
    sendFrom(session, "opening", "ana", null);
    handToAgent(session, "opening");
    session.publishTurn();
    sendFrom(session, "solo-steer", "ana", "opening");
    handToAgent(session, "solo-steer");
    session.renew("ana");
  });
  check(
    world,
    "soloWriteBudget",
    "A solo start, steer and renewal attempt use zero collaboration writes",
    { writes: session.extraWrites(), action: session.view("ana").action },
    { writes: 0, action: "Send" },
  );

  session.saveSnapshot(snapshot);
  session.markRead("ben", "opening");
  session.machinePrompt(routine);
  session.publishPrompt();
  await deliver(
    world,
    "ben",
    "Ben opens the session after Ana has started the turn",
    () => session.join("ben"),
  );
  const joined = session.view("ben");
  check(
    world,
    "lateJoinView",
    "Ben sees his last read point, changed files, decisions, driver and open prompt",
    {
      driver: joined.driver,
      action: joined.action,
      snapshot: joined.snapshot,
      prompt: joined.prompt,
    },
    {
      driver: "ana",
      action: "Queue",
      snapshot: { ...snapshot, lastRead: "opening" },
      prompt: { ...routine, canAnswer: "ana", answeredBy: null },
    },
  );
  check(
    world,
    "joinDoesNotWrite",
    "Opening an already running session makes no claim write",
    session.extraWrites(),
    0,
  );

  await deliver(
    world,
    "ben",
    "Ben asks to steer and the server records Ana's implied claim",
    () => {
      sendFrom(session, "late-steer", "ben", "opening");
    },
  );
  check(
    world,
    "joinPreservesDriver",
    "The first competing steer queues and creates just one claim for Ana",
    {
      driver: session.view("ben").driver,
      state: session.view("ben").messages.at(-1)?.state,
      writes: session.extraWrites(),
    },
    { driver: "ana", state: "queued", writes: 1 },
  );

  await world.advance(BATON_LEASE_MS / 2);
  await world.net.drain();
  await deliver(
    world,
    "ana",
    "Ana renews the claim while both senders are present",
    () => session.renew("ana"),
  );
  check(
    world,
    "renewalWritesOnce",
    "An active holder renews with one write",
    session.extraWrites(),
    2,
  );
  session.leave("ana");
  await world.advance(BATON_LEASE_MS);
  await world.net.drain();
  check(
    world,
    "lapseKeepsAnswerer",
    "When Ana's lease lapses the prompt still names Ana as the owner",
    {
      driver: session.view("ben").driver,
      canAnswer: session.view("ben").prompt?.canAnswer,
    },
    { driver: null, canAnswer: "ana" },
  );

  await deliver(
    world,
    "ben",
    "Ben presses Enter again and can steer the same turn",
    () => {
      session.retryQueuedSteer("late-steer", "ben", {
        kind: "turn",
        turn: "opening",
      });
      session.start("late-steer");
      handToAgent(session, "late-steer");
    },
  );
  check(
    world,
    "joinerDrives",
    "Ben drives and can answer the open routine prompt",
    {
      driver: session.view("ben").driver,
      canAnswer: session.view("ana").prompt?.canAnswer,
      delivered: session.view("ben").transcript.at(-1)?.id,
    },
    { driver: "ben", canAnswer: "ben", delivered: "late-steer" },
  );

  enqueue(world, "ana", "Ana submits the routine card", () =>
    session.answer("ana", routine),
  );
  enqueue(world, "ben", "Ben submits the routine card", () =>
    session.answer("ben", routine),
  );
  await world.net.drain();
  check(
    world,
    "routineAnswerer",
    "Both cards show Ben's answer",
    [
      session.view("ana").prompt?.answeredBy,
      session.view("ben").prompt?.answeredBy,
    ],
    ["ben", "ben"],
  );

  const escalation = { ...routine, run: 2, class: "escalation" } as const;
  await deliver(
    world,
    "machine",
    "The agent restarts and opens an escalation with the same prompt ID",
    () => {
      session.machinePrompt(escalation);
      session.deliverAnswer();
      session.publishPrompt();
    },
  );
  check(
    world,
    "answerRefusedAfterRestart",
    "The old answer leaves the new prompt open for Ana",
    session.view("ben").prompt,
    { ...escalation, canAnswer: "ana", answeredBy: null },
  );
  session.join("ana");
  await deliver(
    world,
    "server",
    "Ben's escalation answer is refused and Ana's is accepted",
    () => {
      session.answer("ben", escalation);
      session.answer("ana", escalation);
      session.deliverAnswer();
      session.publishPrompt();
    },
  );
  check(
    world,
    "ownerAnswersEscalation",
    "Both cards show Ana's answer to the escalation",
    [
      session.view("ana").prompt?.answeredBy,
      session.view("ben").prompt?.answeredBy,
    ],
    ["ana", "ana"],
  );
});
