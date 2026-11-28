import { type QueryCtx } from "../functions";
import { Doc, Id } from "../_generated/dataModel";
import { searchParentId } from "./searchSelf";
import {
  parseSearchTerms,
  contentMatchesAnyTerm,
  conversationMatchesAllTerms,
  rankConversationsByCoverage,
  evidenceWithFields,
  relevanceOf,
  missingWords,
  bestMessages,
  searchFieldsOf,
  type RankedConversation,
  type ParsedTerms,
} from "../searchCore";
import {
  emptyEvidence,
  snippetAround,
  stripWrapperTags,
} from "@codecast/search/terms";
import type { SessionQuery } from "@codecast/search/sessionQuery";
import {
  narrowByOperators,
  type OperatorCandidate,
  type OperatorScope,
} from "../sessionQuerySearch";

// The narrow shape every search consumer actually reads. Both tiers project
// to it so the mirror and the deep index are interchangeable downstream
// (_id is the real messages id either way — deep links depend on it).
export type SearchPoolMessage = {
  _id: Id<"messages">;
  conversation_id: Id<"conversations">;
  role: Doc<"messages">["role"];
  content: string;
  timestamp: number;
  tool_calls_count?: number;
  tool_results_count?: number;
};

type SearchPoolFilter = {
  conversation_id?: Id<"conversations">;
  user_id?: Id<"users">;
  team_id?: Id<"teams">;
};

// Rows one message lookup returns. A lookup that comes back full may have left
// matches behind, so a word the pool lacks is unknown there, not absent.
const MESSAGE_POOL_TAKE = 512;

export async function messageSearchTier(ctx: QueryCtx): Promise<{
  tier: "recent" | "deep";
  search: (
    text: string,
    filter?: SearchPoolFilter,
    take?: number,
  ) => Promise<SearchPoolMessage[]>;
}> {
  // search_mirror_live changes only on liveness transitions, so this read
  // keeps open search subscriptions stable (the walker's per-tick cursor row
  // must never be read here — it would re-run every open search each tick).
  const mirror = await ctx.db.query("search_mirror_live").first();
  if (mirror?.live) {
    return {
      tier: "recent",
      search: async (text, filter = {}, take = MESSAGE_POOL_TAKE) => {
        const rows = await ctx.db
          .query("message_search_recent")
          .withSearchIndex("search_content_r2", (q) => {
            let base: any = q.search("content", text);
            if (filter.conversation_id)
              base = base.eq("conversation_id", filter.conversation_id);
            if (filter.user_id) base = base.eq("user_id", filter.user_id);
            if (filter.team_id) base = base.eq("team_id", filter.team_id);
            return base;
          })
          .take(take);
        return rows.map((r) => ({
          _id: r.message_id,
          conversation_id: r.conversation_id,
          role: r.role,
          content: r.content,
          timestamp: r.timestamp,
          tool_calls_count: r.tool_calls_count,
          tool_results_count: r.tool_results_count,
        }));
      },
    };
  }
  return {
    tier: "deep",
    search: async (text, filter = {}, take = MESSAGE_POOL_TAKE) => {
      if (filter.user_id || filter.team_id) return [];
      const docs = await ctx.db
        .query("messages")
        .withSearchIndex("search_content_v2", (q) => {
          const base = q.search("content", text);
          return filter.conversation_id
            ? base.eq("conversation_id", filter.conversation_id)
            : base;
        })
        .take(take);
      return docs.map((m) => ({
        _id: m._id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content ?? "",
        timestamp: m.timestamp,
        tool_calls_count: m.tool_calls?.length,
        tool_results_count: m.tool_results?.length,
      }));
    },
  };
}

export async function fetchMessageSearchPool(
  ctx: QueryCtx,
  terms: ParsedTerms,
  // Caller identity for SCOPED lookups. The global lookup truncates at 512
  // BM25-ranked rows BEFORE any visibility filtering, so one user's
  // term-heavy private sessions can push every hit the caller may actually
  // see below the cutoff ("workflow" returned zero for everyone while one
  // account's eval sessions owned 464 of the 512 pooled rows). Per-caller and
  // per-team lookups carve out pools the flood cannot touch; the global
  // lookup stays as the catch-all for restamped/edge rows. Scope stamps on
  // mirror rows are snapshots — visibility is still enforced downstream
  // against the live conversation doc.
  scope?: { userId: Id<"users">; teamIds: Id<"teams">[] },
): Promise<{
  pool: SearchPoolMessage[];
  tier: "recent" | "deep";
  saturated: boolean;
}> {
  if (terms.all.length === 0)
    return { pool: [], tier: "deep", saturated: false };
  const searchQuery = terms.lookup;
  const { tier, search } = await messageSearchTier(ctx);
  // Scoped lookups FIRST: coverage ranking downstream is a stable sort, so
  // within a coverage tier pool order decides who survives the candidate
  // slice — the caller's own rows must precede the (possibly flooded)
  // global batch. The deep index has no user/team filter and answers those
  // lookups with nothing.
  const lookups = [];
  if (scope && tier === "recent") {
    lookups.push(search(searchQuery, { user_id: scope.userId }));
    // Bounded: lookup count is what blows budgets, and the global lookup
    // already covers whatever a capped-out team list would have added.
    for (const teamId of scope.teamIds.slice(0, 4)) {
      lookups.push(search(searchQuery, { team_id: teamId }));
    }
  }
  lookups.push(search(searchQuery));
  const batches = await Promise.all(lookups);
  const seen = new Set<string>();
  const pool: SearchPoolMessage[] = [];
  for (const batch of batches) {
    for (const r of batch) {
      const key = r._id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(r);
    }
  }
  return {
    tier,
    pool,
    saturated: batches.some((batch) => batch.length >= MESSAGE_POOL_TAKE),
  };
}

// How many operator-narrowed sessions get a text lookup of their own. The
// shared pool above can miss a narrowed session whose matches rank low
// globally, so every narrowed session the pool and its title have not already
// matched in full is searched on its own, newest first, with a small take
// each, until this many lookups; a cut is reported as truncated.
const OPERATOR_TEXT_LOOKUPS = 150;

const OPERATOR_TEXT_BATCH = 25;

const OPERATOR_TEXT_TAKE = 20;

export type OperatorHit = OperatorCandidate & {
  messages: SearchPoolMessage[];
  scores: number[];
  coverage: number;
  relevance: number;
  missing: string[];
};

// Session query operators (file:, commit:, pr:, ...) narrow the conversations
// first (sessionQuerySearch.ts); the query's free text then runs over only
// those. Shared by searchConversations and searchForCLI, so the web page and
// `cast search` answer an operator query with the same sessions. With no text
// every narrowed session is a hit, newest matching change first.
export async function searchByOperators(
  ctx: QueryCtx,
  q: SessionQuery,
  scope: OperatorScope,
  opts: { userOnly: boolean; skipPool?: boolean },
): Promise<
  | {
      hits: OperatorHit[];
      terms: ParsedTerms;
      tier: "recent" | "deep";
      truncated: string[];
    }
  | { error: string }
> {
  const narrowed = await narrowByOperators(ctx, q, scope);
  if ("error" in narrowed) return narrowed;
  const truncated = narrowed.truncated;
  const terms = parseSearchTerms(q.text);
  const tier = await messageSearchTier(ctx);
  if (terms.all.length === 0) {
    return {
      terms,
      tier: tier.tier,
      truncated,
      hits: narrowed.candidates.map((c) => ({
        ...c,
        messages: [],
        scores: [],
        coverage: 1,
        relevance: 1,
        missing: [],
      })),
    };
  }

  const byId = new Map(
    narrowed.candidates.map((c) => [c.conv._id.toString(), c]),
  );
  const groups = new Map<string, SearchPoolMessage[]>();
  const add = (msgs: SearchPoolMessage[]) => {
    for (const m of msgs) {
      const id = m.conversation_id.toString();
      if (!byId.has(id)) continue;
      if (opts.userOnly && m.role !== "user") continue;
      if (!contentMatchesAnyTerm(m.content || "", terms)) continue;
      const list = groups.get(id) ?? [];
      if (!list.some((x) => x._id === m._id)) list.push(m);
      groups.set(id, list);
    }
  };
  if (!opts.skipPool) {
    add(
      (
        await fetchMessageSearchPool(ctx, terms, {
          userId: scope.viewerId,
          teamIds: scope.teamIds,
        })
      ).pool,
    );
  }
  // A session's title and summaries count as text too: a pseudo-message that
  // takes part in coverage ranking and is dropped from the returned matches.
  const TITLE_ROW = "title" as unknown as Id<"messages">;
  if (!opts.userOnly) {
    for (const c of narrowed.candidates) {
      const fields = searchFieldsOf(c.conv).join(" ");
      if (!fields || !contentMatchesAnyTerm(fields, terms)) continue;
      const id = c.conv._id.toString();
      groups.set(id, [
        ...(groups.get(id) ?? []),
        {
          _id: TITLE_ROW,
          conversation_id: c.conv._id,
          role: "user",
          content: fields,
          timestamp: c.matchedAt,
        },
      ]);
    }
  }

  const searchQuery = terms.lookup;
  const unmatched = narrowed.candidates.filter((c) => {
    const found = groups.get(c.conv._id.toString());
    return !found || !conversationMatchesAllTerms(found, terms);
  });
  const lookups = unmatched.slice(0, OPERATOR_TEXT_LOOKUPS);
  for (let i = 0; i < lookups.length; i += OPERATOR_TEXT_BATCH) {
    const batch = lookups.slice(i, i + OPERATOR_TEXT_BATCH);
    (
      await Promise.all(
        batch.map((c) =>
          tier.search(
            searchQuery,
            { conversation_id: c.conv._id },
            OPERATOR_TEXT_TAKE,
          ),
        ),
      )
    ).forEach(add);
  }
  if (unmatched.length > lookups.length) {
    truncated.push(
      `searched the text in the newest ${lookups.length} of ${unmatched.length} narrowed sessions; narrow further to reach the rest`,
    );
  }

  const hits: OperatorHit[] = rankConversationsByCoverage(groups, terms).map(
    (r) => {
      const candidate = byId.get(r.convId)!;
      const real = r.messages
        .map((m, i) => ({ m, score: r.scores[i] }))
        .filter(({ m }) => m._id !== TITLE_ROW);
      const evidence = evidenceWithFields(
        r,
        searchFieldsOf(candidate.conv),
        terms,
      );
      return {
        ...candidate,
        coverage: r.coverage,
        relevance: relevanceOf(evidence, terms),
        missing: missingWords(evidence, terms),
        messages: real.map(({ m }) => m),
        scores: real.map(({ score }) => score),
      };
    },
  );
  hits.sort((a, b) => b.coverage - a.coverage || b.matchedAt - a.matchedAt);
  return { hits, terms, tier: tier.tier, truncated };
}

// One search result in the making: a conversation, the pooled messages that
// matched in it, and how well the whole answers the query once its own fields
// (title, summaries, opening prompt, earlier titles) count. Every search
// surface ranks and renders from this shape.
export type SearchCandidate = {
  conv: Doc<"conversations">;
  messages: SearchPoolMessage[];
  /** Parallel to `messages`: which rows show the query best. */
  scores: number[];
  coverage: number;
  relevance: number;
  /** Query words the session holds nowhere, messages or own fields. */
  missing: string[];
  /** Worker sessions folded into this row (foldWorkersUnderParents). */
  workers: number;
};

export function searchCandidate(
  conv: Doc<"conversations">,
  ranked: Partial<
    Pick<
      RankedConversation<SearchPoolMessage>,
      "messages" | "scores" | "evidence"
    >
  > & { coverage: number },
  terms: ParsedTerms,
): SearchCandidate {
  const evidence = evidenceWithFields(
    { evidence: ranked.evidence ?? emptyEvidence(terms) },
    searchFieldsOf(conv),
    terms,
  );
  return {
    conv,
    messages: ranked.messages ?? [],
    scores: ranked.scores ?? [],
    coverage: ranked.coverage,
    relevance: relevanceOf(evidence, terms),
    missing: missingWords(evidence, terms),
    workers: 0,
  };
}

// The matches a result row shows: the messages that hold the most of the
// query, the person's own first, each cut to the stretch that shows it.
export function searchSnippets(
  c: Pick<SearchCandidate, "messages" | "scores">,
  terms: ParsedTerms,
  limit = 5,
) {
  return bestMessages(c, limit).map((m) => ({
    message: m,
    content: snippetAround(stripWrapperTags(m.content || ""), terms, 300),
  }));
}

// Workers fold into the session that ran them. A worker's brief repeats its
// parent's words, so one piece of work otherwise fills a page of results with
// its own subagents (six "Workflow harness" rows for one landing page). The
// parent stands for the family, ranked by its best member, and says how many
// workers matched; a worker whose parent the viewer cannot see stays a row.
export async function foldWorkersUnderParents(
  ctx: QueryCtx,
  candidates: SearchCandidate[],
  terms: ParsedTerms,
  isVisible: (conv: Doc<"conversations">) => boolean,
): Promise<SearchCandidate[]> {
  const byId = new Map(candidates.map((c) => [c.conv._id.toString(), c]));
  const loaded = new Map<string, Doc<"conversations"> | null>();
  const load = async (id: Id<"conversations">) => {
    const key = id.toString();
    if (!loaded.has(key))
      loaded.set(key, byId.get(key)?.conv ?? (await ctx.db.get(id)));
    return loaded.get(key)!;
  };
  const folded = new Set<string>();
  const added: SearchCandidate[] = [];
  for (const c of candidates) {
    let root: Doc<"conversations"> | null = null;
    let at = c.conv;
    for (let hops = 0; hops < 4; hops++) {
      const parentId = await searchParentId(ctx, at);
      const parent = parentId ? await load(parentId) : null;
      if (!parent || !isVisible(parent)) break;
      root = at = parent;
    }
    if (!root) continue;
    const rootKey = root._id.toString();
    let host = byId.get(rootKey);
    if (!host) {
      host = searchCandidate(root, { coverage: c.coverage }, terms);
      byId.set(rootKey, host);
      added.push(host);
    }
    host.relevance = Math.max(host.relevance, c.relevance);
    host.coverage = Math.max(host.coverage, c.coverage);
    // The family holds a word when any member does.
    host.missing = host.missing.filter((w) => c.missing.includes(w));
    host.workers++;
    folded.add(c.conv._id.toString());
  }
  return [...candidates, ...added].filter(
    (c) => !folded.has(c.conv._id.toString()),
  );
}
