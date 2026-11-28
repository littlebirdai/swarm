import { query } from "./functions";
import { defineInboxSessionsQuery } from "./lib/inboxSessionsQuery";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { resolveInboxTeamScope } from "./lib/conversationHelpers";
import {
  computeInboxSessions,
  splitInboxList,
  splitInboxLiveness,
} from "./lib/inboxCompute";
import { belowFoldFor } from "./lib/inboxMaps";

export {
  computeInboxSessions,
  splitInboxList,
  splitInboxLiveness,
} from "./lib/inboxCompute";
export { resolveInboxTeamScope } from "./lib/conversationHelpers";
export { belowFoldFor } from "./lib/inboxMaps";

export const listInboxSessions = defineInboxSessionsQuery(
  computeInboxSessions,
  splitInboxList,
);

// Inbox "team mode": the same fully-enriched inbox rows as listInboxSessions, but
// the candidate set is the whole team's team-visible sessions (superset of the
// caller's own). Membership-gated via resolveInboxTeamScope. Mirrors the
// personal query's liveness split — the live subscription passes
// include_liveness:false and rides teamSessionsLiveness — so team mode is as
// heartbeat-cheap as the personal inbox. `fast_fields_in_overlay` is the same
// opt-in as the personal list: the per-message and per-model-call fields ride
// teamSessionsLiveness, so a streaming teammate stops re-pushing the board.
export const listTeamInboxSessions = query({
  args: {
    activeTeamId: v.optional(v.id("teams")),
    show_all: v.optional(v.boolean()),
    include_liveness: v.optional(v.boolean()),
    fast_fields_in_overlay: v.optional(v.boolean()),
    _probe: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      return { sessions: [], hidden_count: 0, truncated: [], team_id: null };
    const teamScope = await resolveInboxTeamScope(
      ctx,
      userId,
      args.activeTeamId,
    );
    if (!teamScope)
      return { sessions: [], hidden_count: 0, truncated: [], team_id: null };
    const result = await computeInboxSessions(ctx, userId, {
      show_all: args.show_all,
      includeLiveness: args.include_liveness,
      fastFieldsInOverlay: args.fast_fields_in_overlay,
      teamScope,
    });
    return { ...result, team_id: teamScope.toString() };
  },
});
