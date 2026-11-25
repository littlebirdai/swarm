import { scenario } from "../dsl";
import { BATON_LEASE_MS } from "../multiplayer-contract";
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
  { name: "multiplayerLateJoin" },
  withMultiplayerSession(async (world, session) => {
    const snapshot = {
      files: ["src/notes.ts"],
      decisions: ["Keep the public signature"],
    };
    const routine = question(1, "1");
    const solo = async () => {
      await session.join("ana");
      await session.announcePresence("ana");
      await sendToAgent(session, send("opening", "ana", null));
      await sendToAgent(session, send("solo-steer", "ana", "opening"));
      await session.renew("ana");
      return refresh(session, "ana");
    };
    const prompt = session
      .openPrompt(routine)
      .then(() => session.publishPrompt());
    const [alone] = await observe(
      world,
      Promise.all([
        solo(),
        session.join("visitor"),
        prompt,
        session.publishSnapshot(snapshot),
        session
          .markRead("ben", "opening")
          .then(() => refresh(session, "visitor")),
      ]),
    );
    check(
      world,
      "soloWriteBudget",
      "One sender and a read-only viewer use zero collaboration writes",
      [session.extraWrites(), alone.action],
      [{ claim: 0, presence: 0 }, "Send"],
    );

    const [joined] = await observe(
      world,
      Promise.all([
        session.join("ben").then(() => refresh(session, "ben")),
        session.relayHeartbeat("ana"),
        refresh(session, "ana"),
      ]),
    );
    check(
      world,
      "lateJoinView",
      "Ben sees the last read point, changed files, decisions, driver and routine prompt",
      [
        joined.driver,
        joined.action,
        joined.snapshot,
        joined.prompt?.class,
        joined.prompt?.canAnswer,
        session.extraWrites(),
      ],
      [
        "ana",
        "Queue",
        { ...snapshot, lastRead: "opening" },
        "routine",
        "ana",
        { claim: 0, presence: 0 },
      ],
    );

    const competingSteer = async () => {
      await session.leave("ben");
      const status = await session.submit(send("late-steer", "ben", "opening"));
      await session.join("ben");
      await session.announcePresence("ana");
      return status;
    };
    const [status] = await observe(
      world,
      Promise.all([competingSteer(), refresh(session, "visitor")]),
    );
    const shared = await observe(world, refresh(session, "ben"));
    check(
      world,
      "joinPreservesDriver",
      "Ben's first steer queues and creates one claim for Ana even without Ben's presence",
      [
        status,
        shared.driver,
        shared.messages.at(-1)?.state,
        session.extraWrites(),
      ],
      ["queued", "ana", "queued", { claim: 1, presence: 1 }],
    );

    const renewSharedClaim = async () => {
      await session.elapse(BATON_LEASE_MS / 2);
      await session.renew("ana");
    };
    await observe(
      world,
      Promise.all([renewSharedClaim(), refresh(session, "ben")]),
    );
    check(
      world,
      "renewalWritesOnce",
      "A shared holder renews with one write",
      session.extraWrites().claim,
      2,
    );

    const renewAlone = async () => {
      await session.leave("ben");
      await session.renew("ana");
      return refresh(session, "ana");
    };
    const aloneWithClaim = await observe(world, renewAlone());
    check(
      world,
      "soloRenewDoesNotWrite",
      "A live claim does not renew after the second sender leaves",
      [aloneWithClaim.driver, session.extraWrites().claim],
      ["ana", 2],
    );
    await observe(
      world,
      Promise.all([session.join("ben"), session.leave("ana")]),
    );
    const lapsed = await observe(
      world,
      session.elapse(BATON_LEASE_MS).then(() => refresh(session, "ben")),
    );
    check(
      world,
      "impliedDriverDoesNotReturn",
      "On expiry the old implied driver does not return",
      lapsed.driver,
      null,
    );

    const promote = async () => {
      await session.join("ana");
      const permit = permitOf(
        await session.retryQueuedSteer("late-steer", "ben", {
          kind: "turn",
          turn: "opening",
        }),
      );
      const result = await complete(session, permit);
      return [result, await refresh(session, "ana")] as const;
    };
    const [[steer, guestDrives]] = await observe(
      world,
      Promise.all([promote(), refresh(session, "ben")]),
    );
    check(
      world,
      "joinerDrives",
      "Ben steers the same turn and can answer the routine prompt",
      [steer, guestDrives.driver, guestDrives.prompt?.canAnswer],
      ["delivered", "ben", "ben"],
    );

    const samePrompt = guestDrives.prompt!.expected;
    const serverRejectsOldAnswer = session.prepareAnswer("ben", {
      ...samePrompt,
      run: 8,
    });
    const [stale] = await observe(
      world,
      Promise.all([serverRejectsOldAnswer, refresh(session, "visitor")]),
    );
    check(
      world,
      "serverRefusesStaleAnswer",
      "The server refuses an answer for a different run",
      stale,
      "stale",
    );

    const [accepted, wrongPerson] = await observe(
      world,
      Promise.all([
        session.prepareAnswer("ben", samePrompt),
        session.prepareAnswer("ana", samePrompt),
      ]),
    );
    check(
      world,
      "routineAnswerer",
      "The holder can answer and the other person is refused",
      [accepted, wrongPerson],
      [samePrompt, "refused"],
    );
    if (typeof accepted === "string") throw new Error("Expected Ben's answer");

    const answeredTwice = await observe(
      world,
      session.prepareAnswer("ben", samePrompt),
    );
    check(
      world,
      "answeredPromptRejectsEligibleRetry",
      "The holder cannot submit a second answer to the same prompt",
      answeredTwice,
      "refused",
    );

    const replacePrompt = async () => {
      await session.openPrompt(question(2, "1"));
      const result = await session.deliverAnswer(accepted);
      await session.publishPrompt();
      return [result, await refresh(session, "ben")] as const;
    };
    const [[machineAnswer, replaced]] = await observe(
      world,
      Promise.all([replacePrompt(), refresh(session, "ana")]),
    );
    check(
      world,
      "answerRefusedAfterRestart",
      "The machine refuses the old answer despite the reused prompt ID",
      [machineAnswer, replaced.prompt?.state, replaced.prompt?.expected.run],
      ["stale", "open", 2],
    );

    await observe(world, session.leave("ben"));
    const fallback = await observe(
      world,
      session.elapse(BATON_LEASE_MS).then(() => refresh(session, "ana")),
    );
    check(
      world,
      "ownerFallback",
      "The open routine prompt returns to Ana when Ben leaves and his lease lapses",
      [
        fallback.driver,
        fallback.prompt?.canAnswer,
        fallback.prompt?.answererOnline,
      ],
      [null, "ana", true],
    );

    const beforeSolo = session.extraWrites();
    const continueAlone = async () => {
      await session.machineTurn(null);
      await session.publishTurn();
      const result = await sendToAgent(
        session,
        send("solo-again", "ana", null),
      );
      await session.renew("ana");
      await session.announcePresence("ana");
      return [result, await refresh(session, "ana")] as const;
    };
    const [[soloAgain, newTurn]] = await observe(
      world,
      Promise.all([continueAlone(), refresh(session, "visitor")]),
    );
    check(
      world,
      "soloAfterShared",
      "After the shared turn and lease end, a solo send makes zero extra writes",
      [soloAgain, newTurn.driver, session.extraWrites()],
      ["delivered", "ana", beforeSolo],
    );

    const recover = async () => {
      await session.machineTurn(null);
      await session.publishTurn();
      await session.closePrompt();
      await session.publishPrompt();
      return refresh(session, "ana");
    };
    const [closed] = await observe(
      world,
      Promise.all([recover(), session.join("ben")]),
    );
    check(
      world,
      "agentClosesPrompt",
      "The agent closes the prompt and the old implied driver clears",
      [closed.prompt?.state, closed.prompt?.canAnswer, closed.driver],
      ["closed", null, null],
    );

    const escalation = {
      run: 2,
      opened: { prompt_id: "2", kind: "permission", summary: "Edit a file" },
    };
    const ownerDeparts = sendToAgent(
      session,
      send("ben-escalation", "ben", null),
    ).then(() => session.leave("ana"));
    const openEscalation = ownerDeparts
      .then(() => session.openPrompt(escalation))
      .then(() => session.publishPrompt());
    const flagged = await observe(
      world,
      Promise.all([ownerDeparts, openEscalation]).then(() =>
        refresh(session, "ben"),
      ),
    );
    const escalationKey = flagged.prompt!.expected;
    const [holder, owner] = await observe(
      world,
      Promise.all([
        session.prepareAnswer("ben", escalationKey),
        session.prepareAnswer("ana", escalationKey),
      ]),
    );
    check(
      world,
      "escalationWaitsForOwner",
      "An escalation waits for the owner while the owner is offline",
      [
        flagged.driver,
        flagged.prompt?.class,
        flagged.prompt?.canAnswer,
        flagged.prompt?.answererOnline,
        holder,
        owner,
      ],
      ["ben", "escalation", "ana", false, "refused", "refused"],
    );

    const resume = async () => {
      await session.join("ana");
      const command = await session.prepareAnswer("ana", escalationKey);
      return typeof command === "string"
        ? command
        : session.deliverAnswer(command);
    };
    const [answered] = await observe(
      world,
      Promise.all([resume(), refresh(session, "ben")]),
    );
    const [ana, ben] = await observe(
      world,
      Promise.all([refresh(session, "ana"), refresh(session, "ben")]),
    );
    check(
      world,
      "ownerAnswersEscalation",
      "Both cards name Ana as the person who answered",
      [answered, ana.prompt?.answeredBy, ben.prompt?.answeredBy],
      ["delivered", "ana", "ana"],
    );

    const revoke = async () => {
      await session.openPrompt(question(2, "before-revoke"));
      await session.publishPrompt();
      const key = (await refresh(session, "ben")).prompt!.expected;
      const queued = await session.submit(
        send("ben-queued", "ben", "ben-escalation", "queue"),
      );
      await session.disconnect();
      const waiting = await session.submit(
        send("ben-saved", "ben", "ben-escalation"),
      );
      await session.revoke("ben");
      const refused = await session.submit(
        send("revoked", "ben", "ben-escalation"),
      );
      const stopped = await session.interrupt("ben", {
        kind: "turn",
        turn: "ben-escalation",
      });
      const answered = await session.prepareAnswer("ben", key);
      return {
        queued,
        waiting,
        refused,
        stopped,
        answered,
        view: await refresh(session, "ben"),
      };
    };
    const [revoked] = await observe(
      world,
      Promise.all([revoke(), refresh(session, "ana")]),
    );
    check(
      world,
      "revokedSender",
      "Revocation removes Ben's baton and actions and turns both sends into suggestions",
      [
        revoked.queued,
        revoked.waiting,
        revoked.refused,
        revoked.stopped.outcome,
        revoked.answered,
        revoked.view.action,
        revoked.view.driver,
        revoked.view.prompt?.canAnswer,
        revoked.view.messages.filter(
          ({ id }) => id === "ben-queued" || id === "ben-saved",
        ),
      ],
      [
        "queued",
        "queued",
        "refused",
        "refused",
        "refused",
        "Read",
        null,
        "ana",
        [
          { id: "ben-queued", state: "suggestion" },
          { id: "ben-saved", state: "suggestion" },
        ],
      ],
    );
  }),
);
