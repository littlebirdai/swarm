import { defineTable } from "convex/server";
import { v } from "convex/values";

export const edgeTranscriptReceiptTables = {
  edge_transcript_receipts: defineTable({
    owner_user_id: v.id("users"),
    device_id: v.string(),
    batch_id: v.string(),
    fingerprint: v.string(),
    receipt_json: v.string(),
    retain_until: v.optional(v.number()),
  })
    .index("by_retention", ["retain_until"])
    .index("by_owner", ["owner_user_id"])
    .index("by_machine_batch", ["owner_user_id", "device_id", "batch_id"]),
};
