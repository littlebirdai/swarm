import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { inboxLeaseWritesEnabled } from "./sessionHeartbeat";

export function stuckSessionRanges(
  db: DatabaseReader,
  conversation: Id<"conversations">,
  now: number,
) {
  const recent = db
    .query("managed_sessions")
    .withIndex("by_conversation_heartbeat", (q) =>
      q
        .eq("conversation_id", conversation)
        .gt("last_heartbeat", now - HEARTBEAT_ALIVE_MS),
    );
  if (!inboxLeaseWritesEnabled()) return [recent];
  return [
    recent,
    db
      .query("managed_sessions")
      .withIndex("by_conversation_active_lease", (q) =>
        q
          .eq("conversation_id", conversation)
          .eq("liveness_lease.expired", false),
      ),
  ];
}
