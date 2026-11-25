import { defineTable } from "convex/server";
import { v } from "convex/values";

export const anchorTables = {
  // ── Anchors ─────────────────────────────────────────────────────────────────
  // A standing agent member: one per team (shared) and one per user (personal).
  // The anchor owns a long-lived `conversation_id` (persistent, pinned, rendered
  // under `bot_user_id`'s identity) that is woken by events and delegates code
  // work to ephemeral `cast spawn` hands. `host_user_id` is the human whose
  // daemon actually runs and bills the session; `bot_user_id` is identity only.
  anchors: defineTable({
    scope_type: v.union(v.literal("team"), v.literal("user")),
    // Exactly one of these is set, matching scope_type.
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")), // the human a personal anchor belongs to
    bot_user_id: v.id("users"), // the synthetic is_bot identity it renders as
    // Who seated it. Who runs and bills it now is the session's user_id (lib/seatPlace).
    host_user_id: v.id("users"),
    conversation_id: v.optional(v.id("conversations")), // the persistent session (once started)
    name: v.string(), // display name; a seat carries its role's
    persona: v.optional(v.string()), // skill name or inline persona reference
    // The seat's folder is its standing session's project_path (lib/seatPlace).
    model: v.optional(v.string()),
    status: v.union(
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("decommissioned"),
    ),
    // Per-anchor governance: cap daily spawned-hand/session count; absent = default.
    daily_session_cap: v.optional(v.number()),
    // Back link to the org role this standing agent serves (org-roles-standing.md
    // T1); absent on the workspace anchor. Reserved for the provisioning wave.
    org_role_id: v.optional(v.id("org_roles")),
    // Its thread reads as a clean chat: the person's messages and what the
    // agent said with `cast say`, and its opening tells it to talk that way.
    // Set on every anchor provisioned since; absent reads as off.
    clean_chat: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_bot_user", ["bot_user_id"])
    .index("by_conversation", ["conversation_id"]),

  // Maps an external comms channel (e.g. a Slack channel) to the anchor that
  // answers there, plus the credentials/config to post back as the bot. Kept
  // separate from `anchors` so one anchor can own several channels and so the
  // Slack adapter can resolve channel → anchor with a single indexed lookup.
  anchor_channels: defineTable({
    anchor_id: v.id("anchors"),
    // "codecast" binds an anchor to a chat channel INSIDE codecast. These rows are
    // an override, not the wiring: a chat channel with no row resolves to its
    // team's anchor through `anchors.by_team`, so mentioning the anchor works with
    // no setup step and no row written per channel that could drift.
    surface: v.union(v.literal("slack"), v.literal("codecast")),
    // Slack: the channel id (e.g. "C0123"). codecast: the chat_channels _id.
    // Unique per surface.
    channel_key: v.string(),
    // Slack workspace/team id, for multi-workspace installs.
    workspace_key: v.optional(v.string()),
    project_path: v.optional(v.string()), // override the anchor's cwd for this channel
    created_at: v.number(),
  })
    .index("by_anchor", ["anchor_id"])
    .index("by_surface_channel", ["surface", "channel_key"])
    // Channel ids are only unique WITHIN a workspace, so multi-workspace routing
    // resolves on (surface, workspace, channel).
    .index("by_workspace_channel", ["surface", "workspace_key", "channel_key"]),
};
