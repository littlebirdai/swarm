import { type MutationCtx } from "../functions";
import { Doc, Id } from "../_generated/dataModel";
import {
  AGENT_CLIENTS,
  agentForksNatively,
} from "@codecast/agent-clients/agentClients";
import { assignConversationToBucketForUser } from "../buckets";

// A fork continues the same thread of work, so it inherits the FORKER's label
// on the source conversation. Labels are per-user filing (bucket_assignments),
// which makes this naturally correct for foreign sources too: forking someone
// else's session inherits nothing unless you had labeled it yourself. Archived
// labels don't propagate.
async function inheritLabelAssignment(
  ctx: MutationCtx,
  userId: Id<"users">,
  sourceConvId: Id<"conversations">,
  newConvId: Id<"conversations">,
) {
  const sourceAssignment = await ctx.db
    .query("bucket_assignments")
    .withIndex("by_user_conversation", (q: any) =>
      q.eq("user_id", userId).eq("conversation_id", sourceConvId),
    )
    .first();
  if (!sourceAssignment?.bucket_id) return;
  const bucket = await ctx.db.get(sourceAssignment.bucket_id);
  if (!bucket || bucket.archived_at) return;
  await assignConversationToBucketForUser(
    ctx,
    userId,
    newConvId,
    sourceAssignment.bucket_id,
  );
}

/**
 * What every fork does to its origin, whichever path made it (a shared link,
 * a message, the daemon's branch of a cloud agent): counts it, unless it is a
 * continuation rather than a fork (an agent switch), and files it under the
 * forker's label on the origin.
 */
export async function recordFork(
  ctx: MutationCtx,
  userId: Id<"users">,
  origin: Pick<Doc<"conversations">, "_id" | "fork_count">,
  forkId: Id<"conversations">,
  opts: { counted?: boolean } = {},
) {
  if (opts.counted !== false)
    await ctx.db.patch(origin._id, {
      fork_count: (origin.fork_count ?? 0) + 1,
    });
  await inheritLabelAssignment(ctx, userId, origin._id, forkId);
}

// opencode forks resolve to a REAL session id via the daemon's serve sidecar
// (POST /session/:id/fork). That needs the parent's real ses_ id to fork from, so
// forkFromMessage passes it down only when this is a same-agent opencode fork whose
// parent already has a resolved ses_ id (not itself an unresolved synthetic fork) and
// the client advertises the forkApi capability. Extracted for unit testing.
//
// The atTip / forkMessageId gate is what keeps a PARTIAL fork honest: opencode's serve
// fork always cuts at a messageID (the message after the fork point) — at tip a full
// fork (no messageID) matches the copy, but a mid-history fork that couldn't resolve
// that messageID must NOT go through the API (it would fork the parent's FULL history
// while the copy shows a truncated one); it falls through to the honest blank spawn.
// A fork the daemon runs through the client's OWN resume-flag fork (registry
// `forkCmd`, e.g. grok). The client copies its whole session state, so this is
// honest only at the tip and only for a plain same-agent fork whose parent has a
// session id the client can resume; the parent's transcript must be on the
// parent's machine, so a cloud fork (worktree on another host) is excluded.
// Extracted for unit testing.
export function nativeForkEligible(opts: {
  isPlainFork: boolean;
  daemonAgentType: string;
  sourceSessionId?: string;
  atTip: boolean;
  cloud: boolean;
}): boolean {
  return (
    opts.isPlainFork &&
    opts.atTip &&
    !opts.cloud &&
    typeof opts.sourceSessionId === "string" &&
    opts.sourceSessionId.length > 0 &&
    agentForksNatively(opts.daemonAgentType)
  );
}

// Clients with a native fork need a real UUID for the child (grok's --session-id
// rejects anything else); a caller-supplied key of another shape is replaced.
export const UUID_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function opencodeApiForkEligible(opts: {
  isPlainFork: boolean;
  daemonAgentType: string;
  sourceAgentType?: string;
  sourceSessionId?: string;
  atTip: boolean;
  forkMessageId?: string;
}): boolean {
  const base =
    opts.isPlainFork &&
    opts.daemonAgentType === "opencode" &&
    opts.sourceAgentType === "opencode" &&
    typeof opts.sourceSessionId === "string" &&
    opts.sourceSessionId.startsWith("ses_") &&
    AGENT_CLIENTS.opencode.capabilities.forkApi === true;
  if (!base) return false;
  return opts.atTip || !!opts.forkMessageId;
}
