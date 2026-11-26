import { afterEach, beforeEach, expect, test } from "bun:test";
import { parsePermitsNextResponse } from "@codecast/edge-contract";
import { asUser } from "../test-helpers/database.testkit";
import {
  boot,
  machine,
  setupRunLease,
} from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";

const flag = "CODECAST_EDGE_DELIVERY_V1";
const originalFlag = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env[flag];
  else process.env[flag] = originalFlag;
});

test("a composer send changes the selected Codex work result and becomes an edge permit", async () => {
  const f = await setupRunLease();
  const claim = await f.claim("live-codex-test");
  if (claim.status !== "granted") throw new Error("Expected a grant");
  const { v, session, run, fencing_token } = claim;
  const fence = { v, session, run, fencing_token };
  const call = async (operation: string, body: object) => {
    const response = await f.t.fetch(`/edge/v1/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const initial = parsePermitsNextResponse(await call("permits.next", fence));
  if (!initial.ok || initial.value.status !== "permit")
    throw new Error("Expected an initial permit");
  const { delivery_id, attempt_id, seq, intent, sender } = initial.value;
  const permit = { ...fence, delivery_id, attempt_id, seq, intent, sender };
  expect(await call("delivery.start", permit)).toMatchObject({
    status: "started",
  });
  expect(
    await call("delivery.settle", { ...permit, outcome: "applied" }),
  ).toMatchObject({ status: "recorded" });

  const handshake = {
    owner_device_id: machine,
    daemon_boot_id: boot,
    protocol_version: 1,
    capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    api_token: f.bearer,
  };
  const work = (ownedCodexConversationId?: string) =>
    f.t.query(api.executionBindings.listExecutionWork, {
      ...handshake,
      ...(ownedCodexConversationId
        ? { owned_codex_conversation_id: ownedCodexConversationId }
        : {}),
    });
  const before = await work(f.conversation);
  const legacyWork = await work();
  const otherSelection = await work("other-conversation");
  expect(before[0]?.nextDeliverySequence).toBe(2);
  expect(legacyWork[0]).not.toHaveProperty("nextDeliverySequence");
  expect(otherSelection).toEqual(legacyWork);

  await asUser(f.t, f.owner).mutation(api.dispatch.dispatch, {
    action: "sendMessage",
    args: [f.conversation, "from the composer", [], "live-codex-message"],
  });
  expect((await work(f.conversation))[0]?.nextDeliverySequence).toBe(3);
  expect(await work()).toEqual(legacyWork);
  expect(await call("permits.next", fence)).toMatchObject({
    status: "permit",
    state: "new",
    delivery_id: "live-codex-message",
    sender: { kind: "person", id: f.owner },
    input: [{ type: "text", text: "from the composer" }],
  });
  delete process.env[flag];
  expect(await work(f.conversation)).toEqual(legacyWork);
});
