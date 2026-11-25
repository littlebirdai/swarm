import { defineTable } from "convex/server";
import { v } from "convex/values";

// A ship of one surface (cli, desktop, backend...) as Changes records it on a
// story ("shipped in cli 1.1.163") and on a day's edition.
const changeReleaseValidator = v.object({
  surface: v.string(),
  version: v.optional(v.string()),
  sha: v.string(),
  at: v.number(),
  // A pushed tag or bump (`release`), or a `cast ship mark` (`deploy`), and the deploy object it recorded (dp-N).
  kind: v.optional(v.union(v.literal("release"), v.literal("deploy"))),
  deploy: v.optional(v.string()),
});

export const changeStoryTables = {
  // A digest of a day, week or month. Two kinds of row share the table: a
  // person's digest (user_id set, events listed) and a team's Changes edition
  // (user_id unset, keyed by team, repository, scope and date), which carries
  // its standfirst in `narrative` and points at change_stories by story_key.
  digests: defineTable({
    user_id: v.optional(v.id("users")),
    team_id: v.optional(v.id("teams")),
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    date: v.string(),
    narrative: v.string(),
    events: v.optional(
      v.array(
        v.object({
          time: v.number(),
          t: v.string(),
          event: v.string(),
          type: v.string(),
          session_id: v.optional(v.id("conversations")),
          session_title: v.optional(v.string()),
          project: v.optional(v.string()),
        }),
      ),
    ),
    session_count: v.optional(v.number()),
    generated_at: v.number(),
    // Team edition fields (docs/proposals/changes-page.md 7.5).
    repository: v.optional(v.string()),
    headline: v.optional(v.string()),
    lead_story_key: v.optional(v.string()),
    section_order: v.optional(v.array(v.string())),
    brief_story_keys: v.optional(v.array(v.string())),
    releases: v.optional(v.array(changeReleaseValidator)),
    stats: v.optional(
      v.object({
        commits: v.number(),
        stories: v.number(),
        releases: v.number(),
        people: v.number(),
        sessions: v.number(),
        private_sessions: v.number(),
      }),
    ),
    inputs_hash: v.optional(v.string()),
    model: v.optional(v.string()),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_usd: v.optional(v.number()),
    // What the row spent under one prompt version: the daily cap counts this,
    // so a new version's rollout starts from zero while cost_usd keeps the total.
    cap_version: v.optional(v.string()),
    cap_cost_usd: v.optional(v.number()),
    // facts: stats headline only; written: prose for a live day; final: the
    // pass after the day ended; failed: prose unavailable, facts stay.
    status: v.optional(
      v.union(
        v.literal("facts"),
        v.literal("written"),
        v.literal("final"),
        v.literal("failed"),
      ),
    ),
    // When the team's daily prose cap first left a story or the edition of
    // this day unwritten. Independent of status: a written edition can be capped.
    capped_at: v.optional(v.number()),
    // Week editions (scope "week", date an ISO week `2026-W40`, changesWeek.ts):
    // the week's biggest stories by key, lead first, and its area totals.
    top_story_keys: v.optional(v.array(v.string())),
    area_totals: v.optional(
      v.array(
        v.object({
          area: v.string(),
          stories: v.number(),
          files: v.number(),
        }),
      ),
    ),
    // The week build scheduled by a day edition finalizing, while it waits.
    scheduled_id: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_user_scope_date", ["user_id", "scope", "date"])
    .index("by_team_scope_date", ["team_id", "scope", "date"])
    .index("by_team_repo_scope_date", [
      "team_id",
      "repository",
      "scope",
      "date",
    ]),

  // One story of a team's Changes edition: one intent, built from the commits
  // and team-visible sessions behind it (docs/proposals/changes-page.md 7.1,
  // 8.1). Team-only by construction, so no `workspace` key: every input passed
  // teamVisibleInputs() when the row was written, and private sessions appear
  // only as a count. `date` is the team-local day (lib/teamDay.ts).
  change_stories: defineTable({
    team_id: v.id("teams"),
    repository: v.string(),
    date: v.string(),
    story_key: v.string(),
    area: v.string(),
    branch: v.string(),
    on_default_branch: v.boolean(),
    commit_shas: v.array(v.string()),
    conversation_ids: v.array(v.id("conversations")),
    pr_ids: v.array(v.id("pull_requests")),
    author_names: v.array(v.string()),
    actor_user_ids: v.array(v.id("users")),
    insertions: v.number(),
    deletions: v.number(),
    files_changed: v.number(),
    area_counts: v.record(v.string(), v.number()),
    release: v.optional(changeReleaseValidator),
    risks: v.array(
      v.object({ code: v.string(), evidence: v.array(v.string()) }),
    ),
    first_at: v.number(),
    last_at: v.number(),
    // Deterministic text from layer 0 first, replaced by prose when it lands.
    headline: v.string(),
    dek: v.string(),
    body: v.optional(v.string()),
    kind: v.string(),
    importance: v.number(),
    why_source: v.optional(
      v.union(
        v.literal("session"),
        v.literal("commit"),
        v.literal("pr"),
        v.literal("none"),
      ),
    ),
    risk_lines: v.optional(v.record(v.string(), v.string())),
    prose_status: v.union(
      v.literal("pending"),
      v.literal("written"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    // Prose calls that failed since the inputs last moved; a failed story is
    // retried until this reaches PROSE_ATTEMPTS (changes.ts).
    prose_attempts: v.optional(v.number()),
    inputs_hash: v.string(),
    generated_at: v.optional(v.number()),
    model: v.optional(v.string()),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_usd: v.optional(v.number()),
    // As on digests: spend under one prompt version, which the daily cap counts.
    cap_version: v.optional(v.string()),
    cap_cost_usd: v.optional(v.number()),
    private_session_count: v.number(),
  })
    .index("by_team_repo_date", ["team_id", "repository", "date"])
    .index("by_team_date", ["team_id", "date"])
    .index("by_story_key", ["story_key"])
    // The per-team daily prose cap sums cost over rows generated today.
    .index("by_team_generated_at", ["team_id", "generated_at"]),

  // Which visible session (and its owner) fed which story, so a visibility
  // or membership change finds the stories to reset without a scan.
  change_story_inputs: defineTable({
    story_id: v.id("change_stories"),
    team_id: v.id("teams"),
    conversation_id: v.id("conversations"),
    owner_id: v.id("users"),
    // The mode the story was built at. A rebuild at a narrower mode resets
    // the prose. Absent reads as `full`, the widest.
    mode: v.optional(v.union(v.literal("summary"), v.literal("full"))),
  })
    .index("by_story", ["story_id"])
    .index("by_conversation", ["conversation_id"])
    .index("by_owner", ["owner_id", "team_id"]),

  // A team day whose Changes edition needs rebuilding, debounced: the first
  // mark schedules one rebuild and later marks ride it (changes-page.md 7.7).
  // `since` is the first mark; a row older than 15 minutes reads as stale.
  change_dirty: defineTable({
    team_id: v.id("teams"),
    repository: v.string(),
    date: v.string(),
    since: v.number(),
    scheduled_id: v.optional(v.id("_scheduled_functions")),
  }).index("by_key", ["team_id", "repository", "date"]),
};
