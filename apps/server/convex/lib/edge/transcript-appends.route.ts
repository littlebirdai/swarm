import {
  EDGE_PROTOCOL_VERSION,
  parseTranscriptAppendResponse,
  type TranscriptAppendReceipt,
} from "@codecast/edge-contract";
import { hashToken, verifyDeviceApiToken } from "@platform/auth/convex";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import type { MutationCtx } from "../../_generated/server";
import { writeMessageBatch, type MessageBatch } from "../../messages";

export async function appendDeviceTranscripts(
  ctx: MutationCtx,
  args: {
    bearer: string;
    batch_id: string;
    writes: (Omit<MessageBatch, "conversation_id"> & {
      conversation_id: string;
    })[];
  },
): Promise<TranscriptAppendReceipt | "unauthorized" | "conflict"> {
  const auth = await verifyDeviceApiToken(ctx, args.bearer);
  if (!auth) return "unauthorized";
  const fingerprint = await hashToken(JSON.stringify(args.writes));
  const prior = await ctx.db
    .query("edge_transcript_receipts")
    .withIndex("by_machine_batch", (q) =>
      q
        .eq("owner_user_id", auth.userId)
        .eq("device_id", auth.deviceId)
        .eq("batch_id", args.batch_id),
    )
    .unique();
  if (prior) {
    if (prior.fingerprint !== fingerprint) return "conflict";
    const parsed = parseTranscriptAppendResponse(
      JSON.parse(prior.receipt_json),
    );
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
  const results: TranscriptAppendReceipt["results"] = [];
  for (const write of args.writes) {
    const id = ctx.db.normalizeId("conversations", write.conversation_id);
    const conversation = id && (await ctx.db.get(id));
    if (
      !conversation ||
      conversation.user_id !== auth.userId ||
      isHostedAgentType(conversation.agent_type)
    ) {
      results.push({ status: "refused" });
      continue;
    }
    const { inserted, ids } = await writeMessageBatch(ctx, conversation, {
      ...write,
      conversation_id: conversation._id,
    });
    results.push({ status: "applied", inserted, ids });
  }
  const receipt: TranscriptAppendReceipt = {
    v: EDGE_PROTOCOL_VERSION,
    batch_id: args.batch_id,
    results,
  };
  await ctx.db.insert("edge_transcript_receipts", {
    owner_user_id: auth.userId,
    device_id: auth.deviceId,
    batch_id: args.batch_id,
    fingerprint,
    receipt_json: JSON.stringify(receipt),
  });
  return receipt;
}
