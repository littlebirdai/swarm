import { expect, test } from "bun:test";
import type { CanonicalEvent } from "@codecast/edge-contract";
import { sessionMachine } from "@codecast/session-contract";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

type EventPayload = {
  [Kind in CanonicalEvent["kind"]]: Pick<
    Extract<CanonicalEvent, { kind: Kind }>,
    "kind" | "body"
  >;
}[CanonicalEvent["kind"]];

const scope = { session: "heartbeat-replay", run: 1 };
const turn = "turn-1";
const promptId = "approval";
const steps = [
  {
    name: "ready",
    status: "idle",
    clientOffset: 1,
    fact: { kind: "session.started", body: {}, turn: null },
  },
  { name: "missing turn start", status: "working", clientOffset: 2 },
  {
    name: "observed turn start",
    status: "working",
    clientOffset: 3,
    fact: { kind: "turn.started", body: {}, turn },
  },
  {
    name: "missing prompt open",
    status: "permission_blocked",
    clientOffset: 4,
  },
  {
    name: "observed prompt open",
    status: "permission_blocked",
    clientOffset: 5,
    fact: {
      kind: "prompt.opened",
      body: { prompt_id: promptId, kind: "permission" },
      turn,
    },
  },
  { name: "missing turn end", status: "idle", clientOffset: 6 },
  {
    name: "observed turn end",
    status: "idle",
    clientOffset: 7,
    fact: { kind: "turn.ended", body: { reason: "completed" }, turn },
  },
  { name: "stale working heartbeat", status: "working", clientOffset: 3 },
] as const satisfies ReadonlyArray<{
  name: string;
  status: "idle" | "working" | "permission_blocked";
  clientOffset: number;
  fact?: EventPayload & Pick<CanonicalEvent, "turn">;
}>;

test("heartbeat replay reports only the known turn divergences", async () => {
  const t = serverTest();
  const at = Date.now() - 1000;
  const { user, managed } = await t.run(async (ctx) => {
    const rows = fixtureRows(ctx.db, "heartbeat replay");
    const user = await rows.user();
    const managed = await ctx.db.insert("managed_sessions", {
      session_id: scope.session,
      user_id: user,
      pid: 1,
      started_at: at,
      last_heartbeat: at,
      agent_status: "idle",
      agent_status_updated_at: at,
      agent_status_write_at: at,
    });
    return { user, managed };
  });
  let state = sessionMachine.initial(scope);
  const divergences = [];
  for (const step of steps) {
    const clientTs = at + step.clientOffset;
    if ("fact" in step) {
      state = sessionMachine.apply(state, {
        kind: "provider.event",
        event: {
          ...scope,
          ...step.fact,
          v: 1,
          seq: step.clientOffset,
          at: clientTs,
          source: "provider",
        },
      }).state;
    }
    const result = await asUser(t, user).mutation(
      api.managedSessions.heartbeat,
      {
        session_id: scope.session,
        agent_status: step.status,
        client_ts: clientTs,
      },
    );
    expect(result.found).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(managed));
    const contract =
      state.turn.status === "running"
        ? "working"
        : state.turn.status === "blocked"
          ? "permission_blocked"
          : "idle";
    if (row?.agent_status !== contract)
      divergences.push({
        step: step.name,
        legacy: row?.agent_status,
        contract,
      });
  }

  console.log("Heartbeat replay divergences", JSON.stringify(divergences));
  expect(divergences).toEqual([
    { step: "missing turn start", legacy: "working", contract: "idle" },
    {
      step: "missing prompt open",
      legacy: "permission_blocked",
      contract: "working",
    },
    {
      step: "missing turn end",
      legacy: "idle",
      contract: "permission_blocked",
    },
  ]);
});
