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
const OUTBOX_CLOCK_LEAD_MS = 24 * 60 * 60 * 1000;
const OUTBOX_RECEIPT_HKDF_INFO = "swarm-dispatch-outbox-v1";

export const outboxValidator = v.object({
  id: v.string(),
  owner: v.string(),
});

export async function dispatchWithOutboxReceipt(
  ctx: MutationCtx,
  owner: Id<"users">,
  action: string,
  acknowledge: boolean | undefined,
  outbox: Infer<typeof outboxValidator> | undefined,
  execute: () => Promise<Value | undefined>,
): Promise<Value | undefined> {
  const respond = async () => {
    const result = await execute();
    if (!acknowledge) return result;
    const held = new Set(await heldKeysFor(ctx, owner));
    return {
      __syncAckV1: syncAckPositions(ctx),
      __syncAckV2: syncAckReceipts(ctx).filter(
        (receipt: { scope_key: string }) => held.has(receipt.scope_key),
      ),
      result,
    };
  };

  if (!outbox) return respond();
  if (outbox.owner !== owner)
    throw new ConvexError({
      code: "OUTBOX_OWNER_MISMATCH",
      message: "Dispatch belongs to a different account",
    });

  const match = /^(\d{13}):[a-zA-Z0-9-]{1,80}$/.exec(outbox.id);
  const queuedAt = Number(match?.[1]);
  const expiresAt = queuedAt + OUTBOX_LIFETIME_MS;
  const now = Date.now();
  if (!match || queuedAt > now + OUTBOX_CLOCK_LEAD_MS || expiresAt <= now)
    throw new ConvexError({
      code: "OUTBOX_EXPIRED",
      message: "Dispatch is outside its delivery window",
    });

  const idHash = await commandArgumentsFingerprint(outbox.id);
  const first = await ctx.db
    .query("dispatch_outbox_receipts")
    .withIndex("by_owner_and_id", (q) =>
      q.eq("owner", owner).eq("id_hash", idHash),
    )
    .unique();
  if (first) {
    if (first.action !== action)
      throw new ConvexError({
        code: "OUTBOX_ID_REUSED",
        message: "Dispatch id belongs to a different action",
      });
    const plaintext = await decryptRefreshToken(
      first.response,
      outbox.id,
      OUTBOX_RECEIPT_HKDF_INFO,
    );
    if (plaintext === null) throw new Error("Could not read dispatch receipt");
    const saved = jsonToConvex(JSON.parse(plaintext));
    if (saved && typeof saved === "object" && "__syncAckV1" in saved) {
      const original = saved as unknown as {
        __syncAckV1: ReturnType<typeof syncAckPositions>;
        __syncAckV2: { scope_key: string }[];
        result?: Value;
      };
      const held = new Set(await heldKeysFor(ctx, owner));
      return {
        ...original,
        __syncAckV1: original.__syncAckV1.filter((position) =>
          held.has(position.scope_key),
        ),
        __syncAckV2: original.__syncAckV2.filter((item) =>
          held.has(item.scope_key),
        ),
      };
    }
    return saved;
  }
  const response = (await respond()) ?? null;
  await ctx.db.insert("dispatch_outbox_receipts", {
    owner,
    id_hash: idHash,
    action,
    response: await encryptRefreshToken(
      JSON.stringify(convexToJson(response)),
      outbox.id,
      OUTBOX_RECEIPT_HKDF_INFO,
    ),
    expires_at: expiresAt,
  });
  return response;
}

export const pruneOutboxReceipts = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const expired = await ctx.db
      .query("dispatch_outbox_receipts")
      .withIndex("by_expiry", (q) => q.lte("expires_at", Date.now()))
      .take(200);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === 200)
      await ctx.scheduler.runAfter(
        1000,
        internal.dispatchReceipts.pruneOutboxReceipts,
        {},
      );
  },
});
