import { defineTable } from "convex/server";
import { v } from "convex/values";

export const orgTemplateTables = {
  // ── Roles hired from a template (docs/architecture/org-hire.md W8) ──
  // A template is a role a person can hire more than once: the folder is its
  // release, this row is what the catalog and the hire form read. `workspace`
  // is the ACCESS key (lib/access): the publishing workspace's key, or the
  // positive value "codecast" for a template every workspace may hire. An
  // absent or unknown key grants nothing.
  org_templates: defineTable({
    template_id: v.string(), // the manifest's slug, unique per publisher
    workspace: v.string(),
    name: v.string(),
    description: v.string(),
    avatar: v.optional(v.string()),
    latest: v.object({ version: v.string(), digest: v.string() }),
    // Oldest first. Same version with another digest is refused at publish.
    releases: v.array(
      v.object({
        version: v.string(),
        digest: v.string(),
        status: v.union(
          v.literal("draft"),
          v.literal("canary"),
          v.literal("stable"),
        ),
        changelog: v.optional(v.string()),
        storage_id: v.optional(v.id("_storage")), // the release snapshot, for install from the record
        manifest: v.any(), // this release's validated manifest; an instance reads its pinned one
        published_at: v.number(),
        published_by: v.id("users"),
        // What it changes against the release before it (orgTemplateRelease.classifyRelease),
        // written at publish; older rows have none and get it computed on read.
        class: v.optional(
          v.union(
            v.literal("content"),
            v.literal("structure"),
            v.literal("authority"),
          ),
        ),
        changes: v.optional(v.any()),
        // Withdrawn by its publisher: never offered to a hire or an update; instances on it are offered the fallback.
        yanked: v.optional(
          v.object({ reason: v.string(), at: v.number(), by: v.id("users") }),
        ),
      }),
    ),
    // Hidden from every catalog by its publisher; its instances keep running.
    retired: v.optional(
      v.object({
        at: v.number(),
        by: v.id("users"),
        reason: v.optional(v.string()),
      }),
    ),
    // The latest release's validated manifest (orgTemplateManifest.OrgTemplate),
    // so the hire form renders inputs, authority and setup without the folder.
    manifest: v.any(),
    // Where lessons for this template are filed as tasks (H9).
    review_project_id: v.optional(v.id("projects")),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_template_id", ["template_id"]),

  // One hire of a template on one project. The receipt on the host stays the
  // local pin; this row is the record the web reads and an upgrade walks.
  // `instance_key` is the receipt's UUID, so the host step upserts by it.
  org_template_instances: defineTable({
    instance_key: v.string(),
    instance: v.string(), // the slug a person chose
    workspace: v.string(), // ACCESS key of the hiring workspace
    template_id: v.string(),
    version: v.string(),
    digest: v.string(),
    project_id: v.id("projects"),
    role_id: v.optional(v.id("org_roles")),
    host: v.optional(v.object({ machine: v.string(), dir: v.string() })),
    phase: v.union(
      v.literal("awaiting_host"),
      v.literal("ready"),
      v.literal("upgrading"),
      v.literal("retired"),
    ),
    update_policy: v.union(
      v.literal("manual"),
      v.literal("canary"),
      v.literal("stable"),
    ),
    // An accepted upgrade change (H9) waits here for the host step (bind --to).
    pending_upgrade: v.optional(
      v.object({
        to: v.string(),
        digest: v.string(),
        accepted_at: v.number(),
        accepted_by: v.id("users"),
      }),
    ),
    // When the row took the release it is pinned to: a canary's runs count from here (H12).
    version_at: v.optional(v.number()),
    // The learning pass's cursor (H12): when this instance was last read, and
    // the structural signals already taught, so one stall teaches once.
    learning: v.optional(
      v.object({ at: v.number(), seen: v.array(v.string()) }),
    ),
    // The host step asked for from the web (H3): the daemon command that runs
    // bind on the machine holding the checkout. The role page reads its outcome.
    bind_request: v.optional(
      v.object({
        command_id: v.id("daemon_commands"),
        device_id: v.string(),
        device_label: v.string(),
        requested_at: v.number(),
        requested_by: v.id("users"),
      }),
    ),
    config: v.optional(v.record(v.string(), v.string())), // hire answers; never a secret
    // Secret inputs bound on a host: which machine, and the hash of the path.
    bindings: v.optional(
      v.record(
        v.string(),
        v.object({
          host: v.string(),
          path_hash: v.string(),
          bound_at: v.number(),
        }),
      ),
    ),
    ledgers: v.optional(
      v.record(
        v.string(),
        v.object({ taskId: v.string(), shortId: v.string() }),
      ),
    ),
    // The routines' triggers on the host's receipt, so the role page can show and activate them (H8).
    routines: v.optional(
      v.record(
        v.string(),
        v.object({
          triggerId: v.optional(v.string()),
          external: v.optional(v.boolean()),
          retired: v.optional(v.boolean()),
        }),
      ),
    ),
    // The instance's own record (orgTemplateState): written by the role with
    // sources a person can open, read by readiness and the role page.
    evidence: v.optional(
      v.record(
        v.string(),
        v.object({
          status: v.union(v.literal("pass"), v.literal("fail")),
          observed_at: v.number(),
          source: v.string(),
          detail: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    ),
    scoreboard: v.optional(
      v.record(
        v.string(),
        v.object({
          value: v.string(),
          observed_at: v.number(),
          source: v.string(),
        }),
      ),
    ),
    setup: v.optional(
      v.record(
        v.string(),
        v.object({
          status: v.union(
            v.literal("open"),
            v.literal("done"),
            v.literal("skipped"),
          ),
          done_at: v.optional(v.number()),
          evidence: v.optional(v.string()),
        }),
      ),
    ),
    // Each setup item's title, price and how-to guide with the instance's
    // values filled in, rendered by the host at bind (it holds the release and
    // the paths): what the role page shows under a setup step.
    setup_text: v.optional(
      v.record(
        v.string(),
        v.object({
          title: v.string(),
          price: v.optional(v.string()),
          guide: v.optional(v.string()),
          needs: v.optional(v.array(v.string())),
        }),
      ),
    ),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_instance_key", ["instance_key"])
    .index("by_workspace", ["workspace"])
    .index("by_role", ["role_id"])
    .index("by_template", ["template_id"]),

  // A lesson an instance sends to its template's publisher (H9). It carries
  // the PUBLISHER's access key: the hiring workspace writes it and afterwards
  // sees only its status, never the publisher's workspace.
  org_template_lessons: defineTable({
    template_id: v.string(),
    workspace: v.string(), // ACCESS key of the publisher, or "codecast"
    from_workspace: v.string(),
    instance_key: v.string(),
    release: v.object({ version: v.string(), digest: v.string() }),
    body: v.string(),
    evidence: v.array(v.object({ label: v.string(), href: v.string() })),
    status: v.union(
      v.literal("open"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("released"),
    ),
    released_in: v.optional(v.string()),
    task_id: v.optional(v.id("tasks")),
    // Who wrote it: the role itself (H9), or the learning pass (H12), whose
    // lessons passed the leak check and say what they are about in the
    // template's own ids. Absent on rows written before the pass existed.
    source: v.optional(v.union(v.literal("role"), v.literal("learning"))),
    kind: v.optional(
      v.union(
        v.literal("redirect"),
        v.literal("setup"),
        v.literal("routine"),
        v.literal("evidence"),
        v.literal("rule"),
      ),
    ),
    about: v.optional(v.string()),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_template_status", ["template_id", "status"])
    .index("by_instance", ["instance_key"]),

  // A workspace's choice to let Codecast learn from its template roles (H12).
  // `workspace` is the ACCESS key of the workspace that chose; no row, or
  // `enabled: false`, means its sessions are never read by a learning pass.
  org_template_learning: defineTable({
    workspace: v.string(),
    enabled: v.boolean(),
    changed_by: v.id("users"),
    changed_at: v.number(),
  }).index("by_workspace", ["workspace"]),
};
