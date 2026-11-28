import { expect } from "bun:test";
import {
  parseDeliverySettleResponse,
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  STEER_BATON_CAPABILITY,
} from "@codecast/edge-contract";
import { TURN_STARTER_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import { asUser } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";
import { setupRunLease } from "./run-lease.testkit";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";

export const observed = { id: "turn", run: 1, start_event_seq: 7 };
export async function steerDeliveryFixture() {
  const f = await setupRunLease();
  const grant = await f.claim("steer-run");
  if (grant.status !== "granted") throw new Error("Expected run lease");
  const fence = {
    v: 1,
    session: f.conversation,
    run: 1,
    fencing_token: grant.fencing_token,
  };
  const { other, projection } = await f.t.run(async ({ db }) => {
    const other = await fixtureRows(db, "kernel other sender").user();
    const binding = (await db.get(f.binding))!;
    await db.patch(f.conversation, { owner_user_id: other });
    await db.patch(f.binding, {
      capabilities: [...binding.required_capabilities, STEER_BATON_CAPABILITY],
    });
    const row = await db.query("run_turn_projections").unique();
    if (!row) throw new Error("Expected initial projection");
    await db.patch(row._id, {
      projection_version: TURN_STARTER_PROJECTION_VERSION,
      turn_ids: [observed.id],
      open_turn: {
        id: observed.id,
        start_event_seq: observed.start_event_seq,
        starter: { kind: "person", id: f.owner },
        prompt_ids: [],
      },
    });
    return { other, projection: row._id };
  });
  const send = (
    client_id: string,
    turn: typeof observed | undefined,
    sender = f.owner,
  ) =>
    asUser(f.t, sender).mutation(api.pendingMessages.sendMessageV2, {
      conversation_id: f.conversation,
      command_id: client_id,
      client_id,
      content: client_id,
      ...(turn ? { observed_turn: turn } : {}),
    });
  const call = async (verb: string, input: object = {}) => {
    const response = await f.t.fetch(`/edge/v1/${verb}`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify({ ...fence, ...input }),
    });
    expect(response.status).toBe(200);
    return await response.json();
  };
  const next = async () => {
    const parsed = parsePermitsNextResponse(await call("permits.next"));
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const permit = async () => {
    const selected = await next();
    if (selected.status !== "permit") throw new Error(JSON.stringify(selected));
    const { delivery_id, attempt_id, seq, intent, sender } = selected;
    return {
      selected,
      request: { delivery_id, attempt_id, seq, intent, sender },
    };
  };
  const begin = async (input: object) => {
    const parsed = parseDeliveryStartResponse(
      await call("delivery.start", input),
    );
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const settle = async (input: object, outcome: string, extra: object = {}) => {
    const parsed = parseDeliverySettleResponse(
      await call("delivery.settle", { ...input, outcome, ...extra }),
    );
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  };
  const turn = (open_turn: Doc<"run_turn_projections">["open_turn"]) =>
    f.t.run(({ db }) => db.patch(projection, { open_turn }));
  const rows = () =>
    f.t.run(async ({ db }) => ({
      head: await db.get(f.head),
      messages: await db
        .query("pending_messages")
        .withIndex("by_conversation_sequence", (q) =>
          q.eq("conversation_id", f.conversation),
        )
        .collect(),
      attempts: await db.query("delivery_attempts").collect(),
    }));
  return {
    ...f,
    fence,
    next,
    permit,
    begin,
    settle,
    turn,
    send,
    rows,
    projection,
    other,
  };
}
