import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  orgChangeReplyValidator,
  orgLogSubjectValidator,
} from "../lib/orgLogValidators";

export const orgChangeTables = {
  // The org log (docs/architecture/org-staffing.md S21): what changed the
  // organization, append only, written inside the transaction that changed
  // it (lib/orgChangeLog). A batch is what a person did in one gesture (an
  // accepted ask, one Settings save, one drag on the chart) and is the entry
  // History shows; an accept all runs over several transactions, so the batch
  // is a row of its own that outlives a mutation. The shapes are
  // @codecast/org/orgChange.
  // `workspace` is the ACCESS key (lib/access): the boundary of the roles the
  // change touched, `team:<id>` or `user:<id>`, written once. `team_id` is
  // ROUTING only. `user_id` is the person who made the change.
  org_change_batches: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    door: v.union(
      v.literal("proposal"),
      v.literal("settings"),
      v.literal("chart"),
      v.literal("project_page"),
      v.literal("initiative"),
      v.literal("cli"),
      v.literal("history"),
    ),
    gesture: v.union(
      v.literal("accept_ask"),
      v.literal("accept_all"),
      v.literal("accept_change"),
      v.literal("reply"),
      v.literal("save"),
      v.literal("drag"),
      v.literal("command"),
      v.literal("undo"),
      v.literal("redo"),
    ),
    // The proposal and the ask the gesture accepted, when there was one.
    proposal: v.optional(
      v.object({
        id: v.id("org_proposals"),
        short_id: v.string(),
        title: v.optional(v.string()),
      }),
    ),
    ask: v.optional(v.object({ index: v.number(), title: v.string() })),
    // What a caller names a gesture by when it spans transactions (accept all).
    key: v.optional(v.string()),
    // The highest row seq, the row count and the kinds inside, kept as rows
    // land so the list never reads the rows.
    seq: v.number(),
    row_count: v.number(),
    kinds: v.record(v.string(), v.number()),
    role_ids: v.array(v.string()),
    lead_row_id: v.optional(v.id("org_changes")),
    // Undo is a new batch, never an erasure: the undo names what it undoes,
    // and the original is stamped with who undid it.
    undoes: v.optional(v.id("org_change_batches")),
    undone_by: v.optional(
      v.object({
        batch: v.id("org_change_batches"),
        user_id: v.id("users"),
        at: v.number(),
      }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspace", "created_at"])
    .index("by_workspace_seq", ["workspace", "seq"])
    .index("by_key", ["workspace", "key"]),

  org_changes: defineTable({
    batch: v.id("org_change_batches"),
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    seq: v.number(), // rising per workspace
    kind: v.string(), // OrgLogKind
    subject: orgLogSubjectValidator,
    // OrgLogFields, OrgLogEffects: typed in the contract, the fields that
    // moved and what the change did beyond its subject. Never a sentence.
    before: v.any(),
    after: v.any(),
    effects: v.any(),
    writes: v.optional(
      v.array(
        v.object({
          table: v.string(),
          id: v.string(),
          before: v.any(),
          after: v.any(),
        }),
      ),
    ),
    labels: v.record(v.string(), v.string()),
    role_ids: v.array(v.string()),
    undoes: v.optional(v.id("org_changes")),
    undone_by: v.optional(v.id("org_changes")),
    created_at: v.number(),
  })
    .index("by_batch", ["batch", "seq"])
    .index("by_workspace_seq", ["workspace", "seq"])
    .index("by_subject", ["subject.id", "seq"]),

  // Staffing proposals (docs/architecture/org-staffing.md S4): a structured
  // set of changes to the chart, authored by an agent (the head of people, an
  // analyzer run) or a person, decided change by change. Access is the anchor
  // rule (lib/orgAccess): team_id / scope_user_id carry the boundary and
  // created_by is the host. Resolves when every change is applied or skipped.
  org_proposals: defineTable({
    short_id: v.string(), // "op-N" from counters.nextShortId
    // Set by an org reset: the proposal belongs to an org that was cleared,
    // so no list returns it and a fresh review starts without it.
    archived_at: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")),
    // Who proposed: a role's standing session, an ordinary session, or a
    // person. `id` is the org_roles / conversations / users id as a string.
    author: v.object({
      kind: v.union(v.literal("role"), v.literal("session"), v.literal("user")),
      id: v.string(),
    }),
    created_by: v.id("users"), // the account the author runs under; the host for access
    title: v.string(),
    summary_md: v.string(),
    mode: v.union(v.literal("init"), v.literal("review"), v.literal("request")),
    status: v.union(
      v.literal("open"),
      v.literal("resolved"),
      v.literal("withdrawn"),
    ),
    evidence_doc_id: v.optional(v.id("docs")),
    // The advisory decision that put the proposal in the addressed person's queue.
    decision_id: v.optional(v.id("session_decisions")),
    // Supersession (org-staffing.md S4): a newer review names the proposal it
    // replaces at create; the older row is stamped back. Both stay open until
    // a person withdraws the older one (the human gate), so the pane can say
    // "Replaced by op-6" instead of leaving two open proposals with no signal.
    supersedes: v.optional(v.id("org_proposals")),
    superseded_by: v.optional(v.id("org_proposals")),
    // When the author applied its own changes as it posted them, because a
    // person let it start work on its own (session filings, a free hire): the
    // card then says the author did it, and no person answered.
    applied_by_author: v.optional(v.number()),
    // The conversation a person talks to about this proposal (org-staffing.md
    // S18): the session that posted it, or the standing session of the role
    // that did. Unset for a proposal a person posted: there is no agent to
    // talk to. Rows from before the field derive it from `author` on read.
    thread_conversation_id: v.optional(v.id("conversations")),
    // The revision journal (S18): one entry per change a revise removed,
    // amended or added, in order, so the page can show the conversation's
    // effect on the list. `line` is the change as it reads after the op,
    // `was` the line an amend replaced.
    revisions: v.optional(
      v.array(
        v.object({
          op: v.union(
            v.literal("removed"),
            v.literal("amended"),
            v.literal("added"),
          ),
          seq: v.number(),
          at: v.number(),
          by: v.object({
            kind: v.union(
              v.literal("role"),
              v.literal("session"),
              v.literal("user"),
            ),
            id: v.string(),
          }),
          line: v.string(),
          was: v.optional(v.string()),
          note: v.optional(v.string()),
        }),
      ),
    ),
    // The asks (org-staffing.md S19): what the proposal asks of the person,
    // each with the changes folded inside it, by seq. Written by the author
    // at create and checked as a partition of the changes; a row without
    // them derives them on read (resolveOrgAsks).
    asks: v.optional(
      v.array(
        v.object({
          title: v.string(),
          why: v.string(),
          effect: v.string(),
          seqs: v.array(v.number()),
        }),
      ),
    ),
    // The person's words on the whole proposal (S39): a reply's note that
    // names no change, kept here so the ledger's closing row says it after
    // the send, on a reload and on another device. The latest such note wins.
    reply: v.optional(orgChangeReplyValidator),
    created_at: v.number(),
    updated_at: v.number(),
    resolved_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_short_id", ["short_id"]),

  org_proposal_changes: defineTable({
    proposal_id: v.id("org_proposals"),
    seq: v.number(),
    // An OrgChange (@codecast/org/orgProposal): validated at
    // create, stored as it was written so an edit is a diff against it.
    change: v.any(),
    rationale: v.string(),
    evidence: v.array(
      v.object({ label: v.string(), href: v.optional(v.string()) }),
    ),
    expected_effect: v.optional(v.string()),
    risk: v.optional(v.string()),
    // proposed → accepted → applied | failed, or proposed → skipped. accepted
    // is momentary: the accept applies in the same mutation.
    // `removed`: the author took it back with a revise (S18); the row stays
    // so the page can show it struck through, and no count includes it.
    status: v.union(
      v.literal("proposed"),
      v.literal("accepted"),
      v.literal("skipped"),
      v.literal("applied"),
      v.literal("failed"),
      v.literal("removed"),
    ),
    // What the last revise did to this row (S18): removed, amended (then
    // `before` is the change as it read) or added, with the author's note.
    revision: v.optional(
      v.object({
        kind: v.union(
          v.literal("removed"),
          v.literal("amended"),
          v.literal("added"),
        ),
        note: v.string(),
        at: v.number(),
        before: v.optional(v.any()),
      }),
    ),
    // The person's edits to the change (an object patch over its keys).
    edits: v.optional(v.any()),
    decided_by: v.optional(v.id("users")),
    decided_at: v.optional(v.number()),
    applied_note: v.optional(v.string()),
    applied_at: v.optional(v.number()),
    // What the accept moved (S39), an OrgAppliedDiffRow per log row the apply
    // wrote: its typed before and after, cut to the fields a card draws.
    // Absent on a row accepted before the field, on a skip, on a failed or
    // no-op apply and on a limit.
    applied_diff: v.optional(
      v.array(
        v.object({
          kind: v.string(), // OrgLogKind
          subject: orgLogSubjectValidator,
          before: v.any(),
          after: v.any(),
          added: v.optional(
            v.object({
              milestones: v.optional(v.array(v.string())),
              questions: v.optional(v.array(v.string())),
              decisions: v.optional(v.array(v.string())),
              sources: v.optional(v.array(v.string())),
            }),
          ),
          labels: v.record(v.string(), v.string()),
          batch: v.optional(v.string()),
        }),
      ),
    ),
    // The person's answer to this change (orgChangeReplyValidator). Shown
    // while `at` is later than the row's last revision; an amend makes the
    // row answerable again.
    reply: v.optional(orgChangeReplyValidator),
    // The author's answer to a question on this change (`cast org revise
    // --answer`). The card shows it under the person's words it came after.
    answer: v.optional(v.object({ text: v.string(), at: v.number() })),
  }).index("by_proposal", ["proposal_id", "seq"]),
};
