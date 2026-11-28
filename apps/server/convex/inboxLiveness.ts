export { INBOX_PROJECTION_FIELDS } from "@codecast/inbox/inboxFields";
import { query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { resolveInboxTeamScope } from "./lib/conversationHelpers";
import { splitInboxLiveness } from "./lib/inboxCompute";
import {
  PLACEMENT_LIVENESS_FIELDS,
  _resetChildAuqProbeCacheForTests,
  buildAskingParents,
  deriveProducingParents,
  groupPoolChildren,
  hasLiveNestedChild,
  inboxDigestDisabled,
  loadPendingDecisionConvIds,
  ownAsk,
  placeConversationRow,
} from "./lib/inboxLivenessPlacement";
import {
  classifyNamedWorkState,
  classifyWorkStates,
  computeSessionsLiveness,
} from "./lib/inboxLivenessState";

export {
  PLACEMENT_LIVENESS_FIELDS,
  placeConversationRow,
  ownAsk,
  buildAskingParents,
  loadPendingDecisionConvIds,
  hasLiveNestedChild,
  groupPoolChildren,
  deriveProducingParents,
  inboxDigestDisabled,
  _resetChildAuqProbeCacheForTests,
} from "./lib/inboxLivenessPlacement";
export {
  computeSessionsLiveness,
  classifyWorkStates,
  classifyNamedWorkState,
} from "./lib/inboxLivenessState";

export const sessionsLiveness = query({
  args: {
    show_all: v.optional(v.boolean()),
    _probe: v.optional(v.number()),
    // The split wire form, as on listInboxSessions.
    split: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId)
      return args.split
        ? splitInboxLiveness({ liveness: {} })
        : { liveness: {} };
    const result = await computeSessionsLiveness(ctx, userId);
    return args.split ? splitInboxLiveness(result) : result;
  },
});

// Team-mode twin of sessionsLiveness: the same tiny heartbeat overlay, but over
// the team-scoped candidate set (so teammate rows on the board refresh their
// live status without the full team list re-pushing every heartbeat). Membership
// gated. Mounted by the client only while team mode is active.
export const teamSessionsLiveness = query({
  args: {
    activeTeamId: v.optional(v.id("teams")),
    _probe: v.optional(v.number()),
    split: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const teamScope =
      userId && (await resolveInboxTeamScope(ctx, userId, args.activeTeamId));
    const result =
      userId && teamScope
        ? await computeSessionsLiveness(ctx, userId, teamScope)
        : { liveness: {} };
    return args.split ? splitInboxLiveness(result) : result;
  },
});
