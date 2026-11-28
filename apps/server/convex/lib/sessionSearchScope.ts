import { query, type QueryCtx } from "../functions";
import { Doc, Id } from "../_generated/dataModel";
import { isRunLog } from "../inboxFilters";
import {
  isTeamMember,
  teamFloorScope,
  type TeamFloor,
  matchDirectoryMapping,
} from "../privacy";
import { linkedPullRequestNumbers } from "./prSessions";
import {
  rankConversationsByCoverage,
  searchFieldsOf,
  type ParsedTerms,
} from "../searchCore";
import { MIRROR_WINDOW_MS } from "../searchMirror";
import { resolveInboxTeamScope } from "./conversationHelpers";
import { searchCandidate } from "./sessionSearchPool";

/** A search scope's people as a list with the viewer first, the order the
 *  operator walks (checkout roots, remotes) spend their budgets in. */
export function usersViewerFirst(
  userById: Map<string, Doc<"users">>,
  viewerId: Id<"users">,
): Doc<"users">[] {
  const viewer = userById.get(viewerId.toString());
  return [
    ...(viewer ? [viewer] : []),
    ...[...userById.values()].filter((u) => u._id !== viewerId),
  ];
}

// Days of message history the recent tier covers — returned to clients so UI
// copy about content-search coverage stays truthful if the window changes.
export const CONTENT_WINDOW_DAYS = Math.round(MIRROR_WINDOW_MS / 86_400_000);

// ONE WORKSPACE PER READ. The scope every session search and feed reads
// through: which teams' sessions the caller sees, who their members are, and
// two gates per conversation. `isVisible` says a session is LISTED (its title
// and summaries may show); `contentVisible` says its CONTENT may show
// (prompts, message snippets, the opening prompt). A teammate's session shared
// as a summary passes the first and fails the second.
//
// Which teams: an explicit team (membership-proven; a team the caller is not in
// is an error), else the one a directory mapping names, else the caller's
// active team (resolveInboxTeamScope), else none, which is the personal
// workspace. Every team the caller belongs to only when the caller asks for it
// by name (allTeams), and then each row says which team it came from
// (workspaceOf). The caller's own sessions follow their routing (see isOwn); `ownTeamId` is
// set when a team was named or mapped, for reads that keep the caller's own
// sessions inside it too.
export type ReadScope = {
  teamIds: Id<"teams">[];
  ownTeamId: Id<"teams"> | undefined;
  teamUsers: Doc<"users">[];
  userById: Map<string, Doc<"users">>;
  isVisible: (conv: Doc<"conversations">) => boolean;
  contentVisible: (conv: Doc<"conversations">) => boolean;
  workspaceOf: (conv: Doc<"conversations">) => string;
  teamNameOf: (conv: Doc<"conversations">) => string | undefined;
};

export async function resolveReadScope(
  ctx: QueryCtx,
  userId: Id<"users">,
  user: Doc<"users">,
  opts: {
    teamId?: Id<"teams">;
    projectPath?: string;
    allTeams?: boolean;
    mineOnly?: boolean;
  },
): Promise<ReadScope | { error: string }> {
  let teamIds: Id<"teams">[] = [];
  let ownTeamId: Id<"teams"> | undefined;
  if (opts.teamId) {
    if (!(await isTeamMember(ctx, userId, opts.teamId)))
      return { error: "Unauthorized team" };
    teamIds = [opts.teamId];
    ownTeamId = opts.teamId;
  } else if (opts.allTeams) {
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    teamIds = memberships.map((m) => m.team_id);
  } else {
    if (opts.projectPath) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      const mapped = matchDirectoryMapping(mappings, opts.projectPath)?.team_id;
      if (mapped && (await isTeamMember(ctx, userId, mapped)))
        ownTeamId = mapped;
    }
    const team = ownTeamId ?? (await resolveInboxTeamScope(ctx, userId));
    teamIds = team ? [team] : [];
  }
  if (opts.mineOnly) teamIds = [];

  const floors = new Map<string, TeamFloor>();
  const teamNames = new Map<string, string>();
  const userById = new Map<string, Doc<"users">>();
  for (const teamId of teamIds) {
    const floor = await teamFloorScope(ctx, teamId);
    floors.set(teamId.toString(), floor);
    if (opts.allTeams)
      teamNames.set(teamId.toString(), (await ctx.db.get(teamId))?.name ?? "");
    for (const u of floor.members) userById.set(u._id.toString(), u);
  }
  const teamUsers = [...userById.values()];
  userById.set(userId.toString(), user);

  // The caller's own sessions follow their routing like everyone else's: a
  // team read lists those routed to that team, a personal read those routed
  // to none. Only an all-teams or mine-only read lists all of them.
  const ownAnywhere = !!opts.allTeams || !!opts.mineOnly;
  const scopeTeam = teamIds.length === 1 ? teamIds[0].toString() : null;
  const isOwn = (conv: Doc<"conversations">) =>
    conv.user_id.toString() === userId.toString() &&
    (ownAnywhere ||
      (scopeTeam ? String(conv.team_id ?? "") === scopeTeam : !conv.team_id));
  const floorFor = (conv: Doc<"conversations">) =>
    conv.team_id ? floors.get(conv.team_id.toString()) : undefined;
  const isVisible = (conv: Doc<"conversations">): boolean => {
    if (isRunLog(conv)) return false;
    if (isOwn(conv)) return true;
    return floorFor(conv)?.isVisible(conv) ?? false;
  };
  const contentVisible = (conv: Doc<"conversations">): boolean => {
    if (isRunLog(conv)) return false;
    if (isOwn(conv)) return true;
    return floorFor(conv)?.contentVisible(conv) ?? false;
  };
  const workspaceOf = (conv: Doc<"conversations">) =>
    conv.team_id ? `team:${conv.team_id}` : `user:${userId}`;
  const teamNameOf = (conv: Doc<"conversations">) =>
    conv.team_id ? teamNames.get(conv.team_id.toString()) : undefined;

  return {
    teamIds,
    ownTeamId,
    teamUsers,
    userById,
    isVisible,
    contentVisible,
    workspaceOf,
    teamNameOf,
  };
}

// A session as search may read it for this viewer: a session whose content is
// hidden keeps only its listed fields (title, summaries, earlier titles), never
// its opening prompt.
export function searchableAs(
  scope: Pick<ReadScope, "contentVisible">,
  conv: Doc<"conversations">,
): Doc<"conversations"> {
  return scope.contentVisible(conv)
    ? conv
    : { ...conv, first_prompt: undefined };
}

// Which workspace a CLI row belongs to, and its team's name when the read
// spans every team, so rows from two teams never read as one list.
export function scopeLabels(
  scope: ReadScope,
  conv: Doc<"conversations">,
): { workspace: string; team?: string } {
  const team = scope.teamNameOf(conv);
  return { workspace: scope.workspaceOf(conv), ...(team ? { team } : {}) };
}

// The web search queries' scope: one workspace (the named team, else the
// active one, else personal), or every team when the caller asks for it.
export async function loadConversationSearchScope(
  ctx: QueryCtx,
  userId: Id<"users">,
  user: Doc<"users">,
  args: { mineOnly?: boolean; activeTeamId?: Id<"teams">; allTeams?: boolean },
): Promise<ReadScope> {
  const scope = await resolveReadScope(ctx, userId, user, {
    teamId: args.activeTeamId,
    allTeams: args.allTeams,
    mineOnly: args.mineOnly,
  });
  // A named team the caller is not a member of scopes to their own sessions.
  if ("error" in scope)
    return resolveReadScope(ctx, userId, user, {
      mineOnly: true,
    }) as Promise<ReadScope>;
  return scope;
}

// Titles and summaries aren't covered by the message index — search them
// directly so a session like "Poll render debug" surfaces even when no
// message body matches. subtitle (multi-line generated summary) and
// idle_summary (one-line blurb) catch sessions the user remembers by their
// summary wording rather than their title. These scans run over the (small)
// conversations table, so they stay within budget even when the message
// full-text search can't (see the fetchMessageSearchPool NOTE) — which is why
// searchConversationTitles exposes them on their own.
// The sessions whose title, subtitle or idle summary the index matches, up to
// TITLE_FIELD_TAKE per field, before any visibility filter. `saturated` when a
// field hit its cap, so more sessions may match than were read.
const TITLE_FIELD_TAKE = 50;

export async function titleFieldRows(ctx: QueryCtx, searchQuery: string) {
  const fieldHits = await Promise.all([
    ctx.db
      .query("conversations")
      .withSearchIndex("search_title_v2", (q) => q.search("title", searchQuery))
      .take(TITLE_FIELD_TAKE),
    ctx.db
      .query("conversations")
      .withSearchIndex("search_subtitle", (q) =>
        q.search("subtitle", searchQuery),
      )
      .take(TITLE_FIELD_TAKE),
    ctx.db
      .query("conversations")
      .withSearchIndex("search_idle_summary", (q) =>
        q.search("idle_summary", searchQuery),
      )
      .take(TITLE_FIELD_TAKE),
  ]);
  return {
    rows: fieldHits.flat(),
    saturated: fieldHits.some((hits) => hits.length >= TITLE_FIELD_TAKE),
  };
}

export async function fetchTitleFieldHits(
  ctx: QueryCtx,
  terms: ParsedTerms,
  // How the viewer may read each session (searchableAs): a session whose
  // content is hidden matches on its listed fields alone.
  view: (conv: Doc<"conversations">) => Doc<"conversations"> = (conv) => conv,
) {
  const { rows } = await titleFieldRows(ctx, terms.lookup);
  // The index matches any one word; a session qualifies only by the same
  // coverage rule content search uses, so "jon stewart" does not surface every
  // summary that mentions a Jon. Best coverage first.
  const convs = new Map<string, Doc<"conversations">>();
  const groups = new Map<string, Array<{ content: string }>>();
  for (const hit of rows) {
    const conv = view(hit);
    const convId = conv._id.toString();
    if (convs.has(convId)) continue;
    convs.set(convId, conv);
    groups.set(convId, [{ content: searchFieldsOf(conv).join(" ") }]);
  }
  return new Map(
    rankConversationsByCoverage(groups, terms).map((r) => {
      const conv = convs.get(r.convId)!;
      return [r.convId, searchCandidate(conv, { coverage: r.coverage }, terms)];
    }),
  );
}

// First-message fetch only feeds a title fallback, so it's only needed for
// the title-less conversations that actually made the displayed slice.
export async function resolveFirstMessageTitles(
  ctx: QueryCtx,
  convs: Doc<"conversations">[],
) {
  const firstMsgByConv = new Map<string, string>();
  await Promise.all(
    convs.map(async (conv) => {
      if (conv.title) return;
      const firstMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", conv._id),
        )
        .order("asc")
        .take(10);
      for (const msg of firstMessages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            let firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            firstMsgByConv.set(conv._id.toString(), firstUserMessage);
            break;
          }
        }
      }
    }),
  );
  return firstMsgByConv;
}

// What a hit's session did, for the line under its title: commits it made and
// tool calls that failed (session_tallies, kept at message write), and pull
// requests it is linked to (the small link rows, never the pull request rows,
// which carry patches). Absent when none, so the line stays short.
export async function searchRowFacts(
  ctx: QueryCtx,
  conv: Doc<"conversations">,
  canSeeTeam: (teamId: Id<"teams">) => Promise<boolean>,
): Promise<{
  commits?: number;
  prs?: number[];
  prs_capped?: boolean;
  failed_tools?: number;
}> {
  const prs = await linkedPullRequestNumbers(ctx, conv._id, canSeeTeam);
  const tallies = conv.session_tallies;
  return {
    ...(tallies?.commits ? { commits: tallies.commits } : {}),
    ...(prs.numbers.length ? { prs: prs.numbers } : {}),
    ...(prs.capped ? { prs_capped: true } : {}),
    ...(tallies?.failed_tools ? { failed_tools: tallies.failed_tools } : {}),
  };
}
