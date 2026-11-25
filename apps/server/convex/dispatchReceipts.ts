import { connectionSecretsKey } from "./tokenConnectors";
// The durable command receipt a dispatch action can carry: the envelope the
// web wraps a local result in, the actions whose server write the receipt
// owns, the continuation a receipt-backed create may run, and the create
// itself run through runLocalCommand so a retry returns the first result.

import type { Id } from "./_generated/dataModel";
import {
  commandArgumentsFingerprint,
  runLocalCommand,
} from "./localFirstCommands";
import {
  ConvexError,
  convexToJson,
  jsonToConvex,
  v,
  type Infer,
  type Value,
} from "convex/values";
import { decryptRefreshToken, encryptRefreshToken } from "./googleOAuth";
import {
  internalMutation,
  syncAckPositions,
  syncAckReceipts,
  type MutationCtx,
} from "./functions";
import { internal } from "./_generated/api";
import { heldKeysFor } from "./lib/accessKeys";

export type ReceiptActionEnvelope = {
  receiptActionVersion: 1;
  commandId: string;
  localResult?: unknown;
};

export function receiptCommandId(action: string, result: unknown): string {
  const envelope = result as Partial<ReceiptActionEnvelope> | null;
  if (
    envelope?.receiptActionVersion !== 1 ||
    typeof envelope.commandId !== "string" ||
    !envelope.commandId
  ) {
    throw new Error(`${action} requires a durable command receipt id`);
  }
  return envelope.commandId;
}

export function hasReceiptCommandId(
  result: unknown,
): result is ReceiptActionEnvelope {
  const envelope = result as Partial<ReceiptActionEnvelope> | null;
  return (
    envelope?.receiptActionVersion === 1 &&
    typeof envelope.commandId === "string" &&
    envelope.commandId.length > 0
  );
}

export const RECEIPT_OWNS_SERVER_WRITE = new Set([
  "createBucket",
  "updateBucket",
  "assignSessionToBucket",
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
  "sendMessage",
]);

export function receiptLocalResult<T>(result: unknown): T {
  return (hasReceiptCommandId(result) ? result.localResult : result) as T;
}

export function receiptOrLegacyCommandId(
  action: string,
  result: unknown,
  legacyCommandId: string,
): string {
  if (hasReceiptCommandId(result)) return receiptCommandId(action, result);
  const payload = result as { commandId?: unknown } | null;
  return typeof payload?.commandId === "string" && payload.commandId
    ? payload.commandId
    : legacyCommandId;
}

type DurableCreateContinuation =
  | { version: 1; kind: "navigate" }
  | { version: 1; kind: "assignBucket"; conversationIds: string[] }
  // A project created from a goal's sheet lands under that goal in the same
  // transaction as the create, so the goal never lists a project that failed.
  | { version: 1; kind: "attachToInitiative"; initiativeId: string };

export function validatedCreateContinuation(
  action: string,
  result: unknown,
): DurableCreateContinuation | null {
  if (!hasReceiptCommandId(result)) return null;
  const localResult = result.localResult;
  if (!localResult || typeof localResult !== "object") return null;
  const raw = (localResult as { continuation?: unknown }).continuation;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid ${action} continuation`);
  }
  const continuation = raw as Record<string, unknown>;
  if (
    continuation.version === 1 &&
    continuation.kind === "navigate" &&
    (action === "createDoc" ||
      action === "createPlan" ||
      action === "createProject")
  ) {
    return { version: 1, kind: "navigate" };
  }
  if (
    continuation.version === 1 &&
    continuation.kind === "assignBucket" &&
    action === "createBucket" &&
    Array.isArray(continuation.conversationIds) &&
    continuation.conversationIds.length > 0 &&
    continuation.conversationIds.length <= 100 &&
    continuation.conversationIds.every(
      (id) => typeof id === "string" && id.length > 0,
    )
  ) {
    return {
      version: 1,
      kind: "assignBucket",
      conversationIds: [...new Set(continuation.conversationIds as string[])],
    };
  }
  if (
    continuation.version === 1 &&
    continuation.kind === "attachToInitiative" &&
    action === "createProject" &&
    typeof continuation.initiativeId === "string" &&
    continuation.initiativeId.length > 0
  ) {
    return {
      version: 1,
      kind: "attachToInitiative",
      initiativeId: continuation.initiativeId,
    };
  }
  throw new Error(`Invalid ${action} continuation`);
}

export async function runReceiptBackedCreate(
  ctx: { db: any },
  userId: Id<"users">,
  input: {
    action: string;
    commandName: string;
    arguments: unknown;
    result: unknown;
    create: () => Promise<unknown>;
  },
) {
  return await runLocalCommand(
    ctx as any,
    {
      principalId: userId,
      commandId: receiptCommandId(input.action, input.result),
      commandName: input.commandName,
      arguments: input.arguments,
    },
    async () => ({
      status: "acknowledged",
      result: await input.create(),
      // Docs/plans/projects still use their legacy paginated sync surfaces. The
      // receipt provides exact create dedupe/result recovery; those lists do not
      // yet expose a revision or command-id coverage contract to name here.
      coverageViews: [],
    }),
  );
}

const OUTBOX_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;
const OUTBOX_RECEIPT_HKDF_INFO = "swarm-dispatch-outbox-v1";
const RECEIPT_CHUNK_SIZE = 512 * 1024;
const PRUNE_BATCH_SIZE = 16;

export const outboxValidator = v.object({
  id: v.string(),
  owner: v.string(),
  age_ms: v.number(),
});

export async function dispatchWithOutboxReceipt(
  ctx: MutationCtx,
  owner: Id<"users">,
  action: string,
  acknowledge: boolean | undefined,
  outbox: Infer<typeof outboxValidator> | undefined,
  execute: () => Promise<Value | undefined>,
): Promise<Value | undefined> {
  const collect = async () => {
    const result = await execute();
    return {
      __syncAckV1: syncAckPositions(ctx),
      __syncAckV2: syncAckReceipts(ctx) as { scope_key: string }[],
      result,
    };
  };
  const respond = async (saved: Awaited<ReturnType<typeof collect>>) => {
    if (!acknowledge) return saved.result;
    const held = new Set(await heldKeysFor(ctx, owner));
    return {
      __syncAckV1: saved.__syncAckV1.filter((position) =>
        held.has(position.scope_key),
      ),
      __syncAckV2: saved.__syncAckV2.filter((receipt) =>
        held.has(receipt.scope_key),
      ),
      result: saved.result,
    };
  };

  if (!outbox) return acknowledge ? respond(await collect()) : execute();
  if (outbox.owner !== owner)
    throw new ConvexError({
      code: "OUTBOX_OWNER_MISMATCH",
      message: "Dispatch belongs to a different account",
    });
  if (
    !/^-?\d{1,16}:(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(
      outbox.id,
    )
  )
    throw new ConvexError({
      code: "OUTBOX_INVALID_ID",
      message: "Dispatch ID must contain a random suffix",
    });
  const expired = () =>
    new ConvexError({
      code: "OUTBOX_EXPIRED",
      message: "Dispatch is outside its delivery window",
    });
  if (
    !Number.isFinite(outbox.age_ms) ||
    outbox.age_ms < 0 ||
    outbox.age_ms > OUTBOX_LIFETIME_MS
  )
    throw expired();

  const now = Date.now();
  const idHash = await commandArgumentsFingerprint(outbox.id);
  const first = await ctx.db
    .query("dispatch_outbox_receipts")
    .withIndex("by_owner_and_id", (q) =>
      q.eq("owner", owner).eq("id_hash", idHash),
    )
    .unique();
  const deploymentKey = connectionSecretsKey();
  const receiptKey = deploymentKey
    ? `${outbox.id}:${deploymentKey}`
    : outbox.id;
  if (first) {
    if (first.expires_at <= now) throw expired();
    if (first.action !== action)
      throw new ConvexError({
        code: "OUTBOX_ID_REUSED",
        message: "Dispatch id belongs to a different action",
      });
    const chunks = await Promise.all(
      (first.response_parts ?? []).map((id) => ctx.db.get(id)),
    );
    if (chunks.some((chunk) => !chunk))
      throw new Error("Dispatch receipt is incomplete");
    const ciphertext =
      first.response + chunks.map((chunk) => chunk!.response).join("");
    const plaintext = await decryptRefreshToken(
      ciphertext,
      first.deployment_key ? receiptKey : outbox.id,
      OUTBOX_RECEIPT_HKDF_INFO,
    );
    if (plaintext === null) throw new Error("Could not read dispatch receipt");
    const saved = jsonToConvex(JSON.parse(plaintext)) as unknown as Awaited<
      ReturnType<typeof collect>
    >;
    return respond(saved);
  }

  const saved = await collect();
  const ciphertext = await encryptRefreshToken(
    JSON.stringify(convexToJson(saved)),
    receiptKey,
    OUTBOX_RECEIPT_HKDF_INFO,
  );
  const expiresAt = now + OUTBOX_LIFETIME_MS;
  const parts: Id<"dispatch_outbox_receipts">[] = [];
  for (
    let offset = RECEIPT_CHUNK_SIZE;
    offset < ciphertext.length;
    offset += RECEIPT_CHUNK_SIZE
  ) {
    parts.push(
      await ctx.db.insert("dispatch_outbox_receipts", {
        owner,
        id_hash: `${idHash}:${offset}`,
        action,
        response: ciphertext.slice(offset, offset + RECEIPT_CHUNK_SIZE),
        expires_at: expiresAt,
      }),
    );
  }
  await ctx.db.insert("dispatch_outbox_receipts", {
    owner,
    id_hash: idHash,
    action,
    response: ciphertext.slice(0, RECEIPT_CHUNK_SIZE),
    ...(parts.length ? { response_parts: parts } : {}),
    ...(deploymentKey ? { deployment_key: true } : {}),
    expires_at: expiresAt,
  });
  return respond(saved);
}

export const pruneOutboxReceipts = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const expired = await ctx.db
      .query("dispatch_outbox_receipts")
      .withIndex("by_expiry", (q) => q.lte("expires_at", Date.now()))
      .take(PRUNE_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === PRUNE_BATCH_SIZE)
      await ctx.scheduler.runAfter(
        1000,
        internal.dispatchReceipts.pruneOutboxReceipts,
        {},
      );
  },
});
