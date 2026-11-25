import { defineTable } from "convex/server";
import { v } from "convex/values";
import { SECRET_EVENT_KINDS } from "@codecast/secrets/secrets";

export const modTables = {
  // Saved list views — a named set of filters/grouping/sort for /tasks, /docs or
  // /plans. These used to live in the owner's client_state bag, which made them
  // per-user by construction: there was nowhere for a teammate to read them
  // from. As a table they can be SHARED, so a view one person tunes shows up on
  // everyone's rail instead of being rebuilt by hand three times.
  //
  // `shared` is the whole access rule: private rows are owner-only, shared rows
  // are readable by any member of the row's team. A shared row without a
  // team_id is a contradiction (nobody to share with), so writes require one.
  // Codecast mods (plan pl-839, packages/mods/src/mods.ts). One row per mod an
  // author owns, carrying the bundle that runs now: `cast mod dev` rewrites it
  // on every save (rev), `cast mod publish` also snapshots it into
  // mod_versions so a version can be read back, diffed and rolled back to.
  // Access is the saved_views rule: the author, or the team it is shared with.
  mods: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    shared: v.optional(v.boolean()),
    name: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    // The validated codecast-mod.json; its shape lives in the shared contract.
    manifest: v.any(),
    // The bundled script (SDK + the author's module) the sandbox runs.
    code: v.string(),
    // The local half (manifest `local`), bundled for the daemon, and its hash:
    // a new hash restarts it on every machine that runs it.
    local_code: v.optional(v.string()),
    local_hash: v.optional(v.string()),
    // The author's machines (by device name) the local half is turned off on.
    local_off: v.optional(v.array(v.string())),
    // What each machine's daemon last said the local half is doing there,
    // written only when that changes.
    local_devices: v.optional(
      v.array(
        v.object({
          device: v.string(),
          state: v.union(
            v.literal("running"),
            v.literal("off"),
            v.literal("failed"),
          ),
          error: v.optional(v.string()),
          at: v.number(),
        }),
      ),
    ),
    // Which of the manifest's secrets the author has set, and when (modSecrets.ts); the values live in mod_secrets.
    secrets_set: v.optional(
      v.array(v.object({ name: v.string(), at: v.number() })),
    ),
    rev: v.number(),
    version: v.number(),
    enabled: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_name", ["user_id", "name"])
    .index("by_team_id", ["team_id"]),

  mod_versions: defineTable({
    mod_id: v.id("mods"),
    version: v.number(),
    manifest: v.any(),
    code: v.string(),
    local_code: v.optional(v.string()),
    local_hash: v.optional(v.string()),
    // The source files as written, path -> text, so a version can be read,
    // forked and diffed without the author's folder.
    source: v.optional(v.any()),
    note: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_mod_version", ["mod_id", "version"]),

  // Objects of the kinds mods declare (packages/mods/src/mods.ts ModObjectKind):
  // `bug-14`, `inc-3`. One table for every kind; `prefix` names the kind and
  // `number` counts per workspace and prefix. `workspace` is the access key,
  // written by computeWorkspaceKey like tasks; `fields` holds the kind's own
  // fields as the declaring manifest types them.
  mod_objects: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    prefix: v.string(),
    number: v.number(),
    short_id: v.string(),
    title: v.string(),
    status: v.optional(v.string()),
    fields: v.optional(v.any()),
    body: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    client_key: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_prefix_number", ["workspace", "prefix", "number"])
    .index("by_workspace_updated", ["workspace", "updated_at"])
    .index("by_short_id", ["short_id"])
    .index("by_client_key", ["client_key"]),

  // A mod's secrets (manifest `secrets`): encrypted values its author set,
  // attached on the server to requests bound for their declared origins
  // (modServer.ts), never sent to a browser.
  mod_secrets: defineTable({
    mod_id: v.id("mods"),
    name: v.string(),
    value_enc: v.string(),
    set_by: v.id("users"),
    updated_at: v.number(),
  }).index("by_mod_name", ["mod_id", "name"]),

  // Vault (docs/architecture/vault.md): the team's keys, logins, files and
  // saved browser sign-ins, one row per secret. `workspace` is ACCESS (a team
  // secret is every member's, a personal one its owner's); team_id is routing.
  // The value lives in secret_values (value_id), never on this row, so the
  // list and every metadata read load no ciphertext. A `requested` row is an
  // agent's ask with no value yet.
  secrets: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    short_id: v.string(),
    name: v.string(),
    kind: v.union(
      v.literal("key"),
      v.literal("login"),
      v.literal("signin"),
      v.literal("file"),
    ),
    status: v.union(v.literal("ready"), v.literal("requested")),
    // The current value (secret_values). value_enc is the LEGACY inline
    // ciphertext of rows written before the split; secrets.moveValuesOut
    // moves it there.
    value_id: v.optional(v.id("secret_values")),
    value_enc: v.optional(v.string()),
    env: v.optional(v.array(v.string())),
    sites: v.optional(v.array(v.string())),
    // A sign-in whose sites or cookies an api token set with no person
    // vouching: whose token it was. Only that user's browsers sign in with it
    // or write it back until a person sets its sites (secrets.ts scopedBy).
    sites_by_token: v.optional(v.id("users")),
    note: v.optional(v.string()),
    // First 4 and last 4 of a key (packages/secrets/src/secrets.ts fingerprint).
    fingerprint: v.optional(v.string()),
    // A sign-in's latest cookie expiry, so the page says when it runs out.
    signin_expires_at: v.optional(v.number()),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_by: v.optional(v.id("users")),
    updated_at: v.number(),
    // When the VALUE last changed (create, rotate, fill, refresh, restore):
    // the version a sign-in's write-back names. updated_at also moves on a
    // metadata edit and is for display. Absent on rows written before it;
    // updated_at stands in until the next write.
    value_updated_at: v.optional(v.number()),
    rotated_at: v.optional(v.number()),
    last_used_at: v.optional(v.number()),
    last_used_by_conversation: v.optional(v.id("conversations")),
    use_count: v.optional(v.number()),
    // A request (`cast vault request`): who asked first, from which session,
    // and why. Every later session that asks for the same name is added to
    // also_requested_from, and the fill wakes them all.
    requested_by: v.optional(v.id("users")),
    requested_from_conversation: v.optional(v.id("conversations")),
    also_requested_from: v.optional(v.array(v.id("conversations"))),
    request_why: v.optional(v.string()),
    // A login with a 2FA seed, set when the value is written (never by decrypting on read).
    has_otp: v.optional(v.boolean()),
    // Ask first: an agent's read needs a person's approval per session (secret_approvals).
    ask_first: v.optional(v.boolean()),
    // How many previous values secret_versions holds for it, kept by every write that moves one.
    version_count: v.optional(v.number()),
  })
    .index("by_workspace", ["workspace"])
    .index("by_workspace_name", ["workspace", "name"])
    .index("by_short_id", ["short_id"]),

  // A person's standing yes to fill a workspace's sign-in requests from their
  // own Chrome on one laptop (signinAutofill.ts). Set only by a person on the
  // web. `tried` holds when each open request was last sent there, keyed by
  // the secret's id, so a signed-out site waits AUTOFILL_RETRY_MS.
  signin_autofill: defineTable({
    user_id: v.id("users"),
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    device_id: v.string(),
    created_at: v.number(),
    tried: v.optional(v.record(v.string(), v.number())),
  })
    .index("by_user_workspace", ["user_id", "workspace"])
    .index("by_workspace", ["workspace"]),

  // A secret's previous values: rotate (and a fulfill over a stored value)
  // keeps the old ciphertext here for 7 days so a person can restore it
  // (secrets.restore); a cron purges the expired ones. A sign-in's cookie
  // refresh writes no version. Bound to its workspace like the row's own.
  secret_versions: defineTable({
    secret_id: v.id("secrets"),
    workspace: v.string(),
    // The kept value (secret_values); value_enc is the LEGACY inline copy.
    value_id: v.optional(v.id("secret_values")),
    value_enc: v.optional(v.string()),
    fingerprint: v.optional(v.string()),
    signin_expires_at: v.optional(v.number()),
    has_otp: v.optional(v.boolean()),
    rotated_at: v.number(),
    rotated_by: v.id("users"),
    expires_at: v.number(),
  })
    .index("by_secret", ["secret_id", "rotated_at"])
    .index("by_expires_at", ["expires_at"]),

  // Every ciphertext a secret holds, current or kept: the payload JSON
  // encrypted under the deployment's connection key with the workspace in its
  // derivation (secrets.ts), so a value moved to another workspace no longer
  // decrypts. A row of its own so that a metadata read never loads up to
  // SECRET_PAYLOAD_MAX of ciphertext per secret: only the value paths (reveal,
  // cliRead, the redaction feed, a rotate's merge) read it, by id. No query
  // returns it.
  secret_values: defineTable({
    secret_id: v.id("secrets"),
    workspace: v.string(),
    value_enc: v.string(),
  }).index("by_secret", ["secret_id"]),

  // Ask first, per session: an agent's read of an ask_first secret files a
  // decision on its conversation (pending); a person's Approve makes it
  // approved for that conversation while it is active, for
  // SECRET_APPROVAL_TTL_MS at most (`at` is when it was approved), Deny
  // denied. A new value or an Ask first switch clears a secret's approvals.
  // The decision is the audit.
  secret_approvals: defineTable({
    secret_id: v.id("secrets"),
    workspace: v.string(),
    conversation_id: v.id("conversations"),
    decision_id: v.id("session_decisions"),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
    ),
    approved_by: v.optional(v.id("users")),
    at: v.number(),
  })
    .index("by_secret_conversation", ["secret_id", "conversation_id"])
    .index("by_decision", ["decision_id"]),

  // Vault's audit trail: every create, change, reveal, agent read and request
  // of a secret, with who and from which session. Kept after the secret is
  // deleted (secret_name says what it was). Only the secret's panel reads it.
  // Rows with no secret are the workspace-wide redaction_sync counts of
  // earlier daemon fetches: none are written now, and nothing reads them.
  secret_events: defineTable({
    secret_id: v.optional(v.id("secrets")),
    workspace: v.string(),
    secret_name: v.optional(v.string()),
    // So the trail stays findable by sec-N after the secret is deleted.
    secret_short_id: v.optional(v.string()),
    kind: v.union(...SECRET_EVENT_KINDS.map((k) => v.literal(k))),
    actor_user_id: v.optional(v.id("users")),
    conversation_id: v.optional(v.id("conversations")),
    // What an agent read it for: get, run, env, otp or signin.
    purpose: v.optional(v.string()),
    // The approval decision an ask_first read filed or that settled it.
    decision_id: v.optional(v.id("session_decisions")),
    // Those old workspace-wide rows: how many values the daemon received.
    count: v.optional(v.number()),
    at: v.number(),
  })
    .index("by_secret_at", ["secret_id", "at"])
    // Whether a value reached a user since it was written (secrets.ts reachedUser).
    .index("by_secret_actor_kind_at", [
      "secret_id",
      "actor_user_id",
      "kind",
      "at",
    ])
    .index("by_short_id_at", ["secret_short_id", "at"])
    .index("by_workspace_at", ["workspace", "at"]),

  // What a mod's local half published ($.publish): one value per mod and key,
  // the latest write wins. The web syncs these into the store, so the
  // sandboxed half reads them like any other data ($.local.get).
  mod_state: defineTable({
    mod_id: v.id("mods"),
    user_id: v.id("users"),
    key: v.string(),
    value: v.any(),
    device_name: v.optional(v.string()),
    updated_at: v.number(),
  })
    .index("by_mod_key", ["mod_id", "key"])
    .index("by_user", ["user_id"]),

  // A call from a mod's UI to its local half ($.local.call): queued here,
  // claimed by a daemon that runs that half, answered with a result or an error.
  mod_calls: defineTable({
    mod_id: v.id("mods"),
    // The author: whose machines run the call. caller_id is who made it and reads the answer.
    user_id: v.id("users"),
    caller_id: v.optional(v.id("users")),
    method: v.string(),
    args: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    device_name: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_status", ["user_id", "status"])
    .index("by_mod_created", ["mod_id", "created_at"]),

  // What a running mod said: console lines, thrown errors, refused calls. The
  // author's loop reads them with `cast mod logs`; capped per mod on write.
  mod_logs: defineTable({
    mod_id: v.id("mods"),
    user_id: v.id("users"),
    level: v.string(),
    text: v.string(),
    created_at: v.number(),
  }).index("by_mod_created", ["mod_id", "created_at"]),

  saved_views: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    // "workspace" = a layout workbench: a saved arrangement of the chrome
    // itself (rails, panels, sizes) rather than of a list page's filters.
    page: v.union(
      v.literal("tasks"),
      v.literal("docs"),
      v.literal("plans"),
      v.literal("decisions"),
      v.literal("workspace"),
    ),
    // The list preferences this view restores. Deliberately loose: the pages own
    // their own pref vocabularies and grow new filters often, and a view is only
    // ever handed straight back to the page that wrote it.
    prefs: v.any(),
    shared: v.optional(v.boolean()),
    // Presentation, so a rail of views is scannable rather than a wall of text.
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    // Client-minted idempotency key: an optimistic create writes a stub under
    // this key and the server row supersedes it, so a retried create can never
    // leave two copies of the same view.
    client_key: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_client_key", ["client_key"]),
};
