import { expect, test } from "bun:test";
import type { SessionFact } from "@codecast/session-contract";
import { sessionMachine } from "@codecast/session-contract";
import { api } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const scope = { session: "managed-status-replay", run: 1 };
const steps = [
  { name: "ready", status: "idle", event: "session.started", turn: null },
  { name: "presumed work", status: "thinking", presumed: true },
  {
    name: "first turn starts",
    status: "working",
    event: "turn.started",
    turn: "first",
  },
  { name: "session boundary", status: "idle", sessionBoundary: true },
  {
    name: "first turn ends",
    status: "idle",
    event: "turn.ended",
    turn: "first",
  },
  {
    name: "second turn starts",
    status: "working",
    event: "turn.started",
    turn: "second",
  },
  { name: "uncorrelated completion stamp", status: "idle", completion: true },
  {
    name: "second turn ends",
    status: "idle",
    event: "turn.ended",
    turn: "second",
  },
  { name: "hibernate", status: "hibernated", park: true },
  { name: "resume", status: "idle", resume: true },
  { name: "stale work report", status: "working", stale: true },
] as const;

type Observation = Extract<(typeof steps)[number], { event: string }>;
function observedFact(step: Observation, seq: number, at: number): SessionFact {
  const envelope = { ...scope, seq, at, v: 1, source: "provider" } as const;
  switch (step.event) {
    case "session.started":
      return {
        kind: "provider.event",
        event: { ...envelope, kind: step.event, turn: step.turn, body: {} },
      };
    case "turn.started":
      return {
        kind: "provider.event",
        event: { ...envelope, kind: step.event, turn: step.turn, body: {} },
      };
    case "turn.ended":
      return {
        kind: "provider.event",
        event: {
          ...envelope,
          kind: step.event,
          turn: step.turn,
          body: { reason: "completed" },
        },
      };
  }
}

test("managed status replay reports only the known divergences", async () => {
  const t = serverTest();
  const at = Date.now() - 1000;
  const { user, conversationId, id } = await t.run(async (ctx) => {
    const rows = fixtureRows(ctx.db, "managed status replay");
    const user = await rows.user();
    const conversationId = await rows.conversation(user, {
      session_id: scope.session,
    });
    const id = await ctx.db.insert("managed_sessions", {
      session_id: scope.session,
      conversation_id: conversationId,
      user_id: user,
      pid: 1,
      started_at: at,
      last_heartbeat: at,
      agent_status: "idle",
    });
    return { user, conversationId, id };
  });
  const client = asUser(t, user);
  let state = sessionMachine.initial(scope);
  const divergences: string[] = [];
  for (const [index, step] of steps.entries()) {
    const seq = index + 1;
    const clientTs = at + ("stale" in step ? 1 : seq);
    if ("event" in step)
      state = sessionMachine.apply(
        state,
        observedFact(step, seq, clientTs),
      ).state;
    const result = await client.mutation(
      api.managedSessions.updateAgentStatus,
      {
        conversation_id: conversationId,
        agent_status: step.status,
        client_ts: clientTs,
        ...("presumed" in step ? { presumed: true } : {}),
        ...("sessionBoundary" in step ? { session_boundary: true } : {}),
        ...("completion" in step ? { turn_completed_at: clientTs } : {}),
        ...("park" in step ? { hibernated_at: clientTs } : {}),
        ...("resume" in step
          ? { hibernated_at: null, session_boundary: true }
          : {}),
      },
    );
    expect(result.applied).toBe(!("stale" in step));
    const row = await t.run((ctx) => ctx.db.get(id));
    const reported =
      row?.hibernated_at !== undefined
        ? "parked"
        : row?.agent_status === "working" || row?.agent_status === "thinking"
          ? "working"
          : "idle";
    const derived = state.turn.status === "running" ? "working" : "idle";
    if (reported !== derived)
      divergences.push(`${step.name}: ${reported} / ${derived}`);
  }

  console.log("Managed status replay divergences", divergences);
  expect(divergences).toEqual([
    "presumed work: working / idle",
    "session boundary: idle / working",
    "uncorrelated completion stamp: idle / working",
    "hibernate: parked / idle",
  ]);
});
