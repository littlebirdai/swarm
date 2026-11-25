import { presentToken } from "@platform/auth/tokenFormat";
import { internal } from "../convex/_generated/api";
import { hashToken } from "../convex/apiTokens";
import {
  claimNextDeliveryInDb,
  EXECUTION_PROTOCOL_CAPABILITIES,
} from "../convex/executionBindings";
import { serverTest } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";

export const start = 1_790_000_000_000;
export const leaseMs = 30_000;
export const machine = "run-machine";
export const boot = "run-boot";
const claimFn = internal.edgeRunLease.claim;

export async function setupRunLease() {
  const t = serverTest();
  const tokens = [
    { secret: "run-owner", device: machine },
    { secret: "run-other-device", device: "wrong-machine" },
    { secret: "run-other-user", device: machine },
    { secret: "run-unbound", device: undefined },
  ];
  const hashes = await Promise.all(
    tokens.map(({ secret }) => hashToken(secret)),
  );
  const { owner, conversation, head, binding, message } = await t.run(
    async ({ db }) => {
      const rows = fixtureRows(db, "edge run lease");
      const owner = await rows.user();
      const other = await rows.user();
      for (const [index, { device }] of tokens.entries()) {
        await db.insert("api_tokens", {
          user_id: index === 2 ? other : owner,
          name: "lease fixture",
          token_hash: hashes[index],
          device_id: device,
          created_at: start,
          last_used_at: start,
        });
      }
      const conversation = await rows.conversation(owner, {
        agent_type: "codex",
        execution_protocol_state: "fenced",
      });
      const head = await db.insert("conversation_execution_heads", {
        conversation_id: conversation,
        owner_user_id: owner,
        protocol_state: "fenced",
        protocol_version: 1,
        current_epoch: 1,
        admission_epoch: 1,
        next_conversation_sequence: 2,
        next_nonterminal_sequence: 1,
        created_at: start,
        updated_at: start,
      });
      const binding = await db.insert("execution_bindings", {
        conversation_id: conversation,
        epoch: 1,
        owner_user_id: owner,
        owner_device_id: machine,
        daemon_boot_id: boot,
        requested_agent: "codex",
        transport: "app-server",
        project_path: "/fixture",
        configuration_revision: 1,
        protocol_version: 1,
        required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        operation_id: "operation",
        handle: "handle",
        state: "ready",
        actual_agent: "codex",
        runtime_id: "runtime",
        applied_configuration_revision: 1,
        created_at: start,
        updated_at: start,
      });
      const message = await db.insert("pending_messages", {
        conversation_id: conversation,
        from_user_id: owner,
        owner_user_id: owner,
        content: "queued",
        status: "pending",
        created_at: start,
        retry_count: 0,
        client_id: "delivery",
        delivery_id: "delivery",
        delivery_protocol_version: 1,
        conversation_sequence: 1,
        execution_epoch: 1,
        delivery_status: "pending",
      });
      return { owner, conversation, head, binding, message };
    },
  );
  const [bearer, wrongDevice, wrongUser, unbound] = tokens.map(
    ({ secret, device }) => (device ? presentToken(secret, device) : secret),
  );
  const address = { conversation_id: conversation, bearer };
  const context = { ...address, machine, boot };
  const claim = (claim_id: string, overrides: Partial<typeof context> = {}) =>
    t.mutation(claimFn, { ...context, claim_id, ...overrides });
  const requestFence = (fencing_token: string, run = 1) => ({
    ...address,
    run,
    fencing_token,
  });
  const deliver = (fencingToken?: string, now = Date.now()) =>
    t.run((ctx) =>
      claimNextDeliveryInDb(ctx, owner, {
        conversationId: conversation,
        executionEpoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: boot,
        runtimeId: "runtime",
        fencingToken,
        now,
      }),
    );
  return {
    t,
    bearer,
    owner,
    conversation,
    head,
    binding,
    message,
    claim,
    requestFence,
    deliver,
    wrongDevice,
    wrongUser,
    unbound,
  };
}
