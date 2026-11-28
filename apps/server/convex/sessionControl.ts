import { fencedMoveRefusal } from "./lib/fenced-device-move.rules";
import {
  mutation,
  query,
  syncAckReceipts,
  type MutationCtx,
} from "./functions";
import { syncLogDisabled } from "./syncLog";
import { v, type GenericValidator, type ObjectType } from "convex/values";
import { enqueueStartSession } from "./devices";
import {
  CLOUD_UNPARK_PATCH,
  parkOnCloudHost,
  resolveCloudDevice,
  supersedeCloudSpawns,
  unparkForMove,
} from "./cloudPlacement";
import { cloudStartFromArg, cloudWorkspaceValidator } from "./cloudPlacement";
import { agentTypeChangeRefusal } from "@codecast/agent-clients/agentClients";
import { cloudPlacementFor } from "@codecast/cloud-hosts/cloudPlacement";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc } from "./_generated/dataModel";
import { enqueuePendingMessage } from "./pendingMessages";
import { requireSessionCommandTarget } from "./daemonCommandUtils";
import {
  AGENT_MODEL_CONFIG,
  AGENT_CLIENTS,
  modelAgentKey,
  fromConvexAgentType,
  findModelOption,
  canSessionBecomeAgent,
} from "@codecast/agent-clients/agentClients";
import { formatAgentSwitchNotice } from "@codecast/agent-clients/agentSwitch";
import { isSessionOwner } from "./sessionOwners";
import { navPromptField } from "./userMessagesFilter";
import { resolveTeamForPath } from "./privacy";
import { advanceCommentsAccessRevision } from "./commentViewWrites";
import { getAuthenticatedUserId } from "./lib/conversationHelpers";
import {
  enqueueKillAndResume,
  resolveCommandableSession,
  sessionCommandResult,
} from "./lib/sessionRestartHelpers";

const reconfigureSessionArgs = {
  conversation_id: v.id("conversations"),
  agent_type: v.optional(
    v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok"),
      v.literal("muse"),
      v.literal("antigravity"),
    ),
  ),
  project_path: v.optional(v.string()),
  git_root: v.optional(v.string()),
  isolated: v.optional(v.boolean()),
  // The machine picked on the new-session page. Routing honours it while it's
  // online and otherwise falls back, so ownership follows the resolved route
  // (stamped by enqueueStartSession) rather than the request. Naming a
  // NON-cloud device for a row parked on the cloud host UN-PARKS it; naming
  // the host itself re-decides the placement for the (new) folder: a folder
  // the host already holds starts there plainly, anything else re-parks.
  target_device_id: v.optional(v.string()),
  // "Run in the cloud" for a (blank) existing row: park it on this host
  // (cloudPlacement.parkOnCloudHost). Runner-only — co-owners are refused.
  cloud_device_id: v.optional(v.string()),
  // With cloud_device_id: the workspace the park should prepare (absent =
  // the row's own stamp, else isolated).
  cloud_workspace: v.optional(cloudWorkspaceValidator),
  // With cloud_device_id: what the worktree starts from (absent = the row's
  // own stamp, else checkout). A change re-parks like a folder change.
  cloud_start_from: v.optional(cloudStartFromArg),
  // Launch model/effort for the (blank) session — option keys from the
  // shared contract. "default" clears the stamp and omits the flag. Launch
  // flags leave no transcript echo, so the stamp here is the only record
  // until the first assistant turn confirms.
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  // A parked create can land with an earlier stable-context selection than
  // the still-local stub. Rekey reconciliation relaunches the blank session
  // through this mutation with the latest values before its first message.
  stable_mode: v.optional(v.string()),
  stable_exclude: v.optional(v.array(v.string())),
};

const reconfigureSessionDefinition = {
  args: reconfigureSessionArgs,
  handler: async (
    ctx: MutationCtx,
    args: ObjectType<typeof reconfigureSessionArgs>,
  ) => {
    const matches = (field: GenericValidator, value: unknown): boolean => {
      if (value === undefined) return field.isOptional === "optional";
      if (field.kind === "literal") return field.value === value;
      if (field.kind === "union")
        return field.members.some((member: GenericValidator) =>
          matches(member, value),
        );
      if (field.kind === "array")
        return (
          Array.isArray(value) &&
          value.every((item) => matches(field.element, item))
        );
      if (field.kind === "id")
        return (
          typeof value === "string" &&
          !!ctx.db.normalizeId("conversations", value)
        );
      return field.kind === typeof value;
    };
    for (const [key, value] of Object.entries(args)) {
      const field: GenericValidator | undefined =
        Object.getOwnPropertyDescriptor(reconfigureSessionArgs, key)?.value;
      if (!field || !matches(field, value))
        throw new Error(
          `ArgumentValidationError: Invalid reconfigureSession argument ${key}`,
        );
    }
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (
      !conv ||
      (conv.user_id !== userId &&
        !(await isSessionOwner(ctx, conv._id, userId)))
    )
      throw new Error("Not found");
    const targetChanged =
      args.target_device_id !== undefined &&
      args.target_device_id !== conv.owner_device_id;
    if (args.cloud_device_id !== undefined || targetChanged) {
      const reason = fencedMoveRefusal(conv);
      if (reason) return { reconfigured: false as const, reason };
    }
    const hostedRefusal = agentTypeChangeRefusal(
      conv.agent_type,
      "claude_code",
    );
    if (hostedRefusal) throw new Error(hostedRefusal);
    if ((conv.message_count ?? 0) > 0)
      throw new Error("Cannot reconfigure session with messages");
    const priorProjectPath = conv.project_path;
    if (args.cloud_device_id) {
      if (userId !== conv.user_id)
        throw new Error("Only the session's runner can move it to the cloud");
      await resolveCloudDevice(ctx, conv.user_id, args.cloud_device_id);
    }
    // Re-pointing a parked row is the runner's call, like parking it: a
    // co-owner may pick a model on a preparing row but not cancel or move
    // the runner's placement.
    if (
      conv.cloud_placement === "pending" &&
      args.target_device_id &&
      userId !== conv.user_id
    ) {
      throw new Error("Only the session's runner can move it off the cloud");
    }
    // Un-park: a row parked on the cloud host pointed back at a laptop. The
    // placement is cancelled (a late `cast cloud start` is fenced by the
    // token and removes the worktree it acquired), the live cloud_spawn is
    // superseded, and the normal start below sees a non-pending row.
    let hostTarget: any = null;
    const patch: Record<string, any> = { updated_at: Date.now() };
    if (
      !args.cloud_device_id &&
      conv.cloud_placement === "pending" &&
      args.target_device_id
    ) {
      const target = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) =>
          q.eq("user_id", conv.user_id).eq("device_id", args.target_device_id),
        )
        .first();
      const unparkFields = await unparkForMove(ctx, conv, target);
      if (Object.keys(unparkFields).length > 0)
        Object.assign(patch, unparkFields, {
          owner_device_id: undefined,
          session_error: undefined,
        });
      else if (target && target.device_id === conv.owner_device_id)
        hostTarget = target;
    }
    if (args.agent_type) patch.agent_type = args.agent_type;
    if (args.agent_type && args.agent_type !== conv.agent_type) {
      patch.model = undefined;
      patch.effort = undefined;
    }
    const reconfAgent = args.agent_type || conv.agent_type || "claude_code";
    const launchCfg = AGENT_MODEL_CONFIG[modelAgentKey(reconfAgent)];
    const launchModelOpt = args.model
      ? launchCfg?.models.find((m) => m.key === args.model)
      : undefined;
    if (args.model !== undefined) {
      if (!launchModelOpt) throw new Error(`Unknown model: ${args.model}`);
      patch.model = launchModelOpt.cliAlias
        ? modelAgentKey(reconfAgent) === "claude"
          ? `claude-${launchModelOpt.key}`
          : launchModelOpt.key
        : undefined;
    }
    if (args.effort !== undefined) {
      if (args.effort === "default") {
        patch.effort = undefined;
      } else {
        if (!launchCfg?.efforts.includes(args.effort))
          throw new Error(`Unknown effort: ${args.effort}`);
        patch.effort = args.effort;
      }
    }
    if (args.project_path !== undefined) {
      patch.project_path = args.project_path;
      patch.git_root = args.git_root ?? args.project_path;
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      const { teamId, isPrivate, autoShared } = resolveTeamForPath(
        mappings,
        args.project_path,
        undefined,
      );
      if (teamId) patch.team_id = teamId;
      patch.is_private = isPrivate;
      patch.auto_shared = autoShared || undefined;
    }
    // A pending row re-pointed at its host: with the folder it will have
    // AFTER this patch, does the host already hold it? Then the placement is
    // done with (no laptop needs to prepare anything) and the row starts on
    // the host like any native launch. Otherwise it stays parked — re-parked
    // when the folder moved, a no-op while a live cloud_spawn is preparing.
    let unparkToHost = false;
    if (hostTarget) {
      const devices = await ctx.db
        .query("devices")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", conv.user_id))
        .collect();
      const locals = devices.filter((d: any) => !d.is_remote);
      const paths = [
        patch.git_root ?? conv.git_root,
        patch.project_path ?? conv.project_path,
      ];
      unparkToHost =
        cloudPlacementFor({ target: hostTarget, locals, paths }) === "native";
      if (unparkToHost)
        Object.assign(patch, CLOUD_UNPARK_PATCH, { session_error: undefined });
    }
    await ctx.db.patch(args.conversation_id, patch);
    // A project-path change re-resolves team/privacy; if the access inputs
    // actually moved, advance the comment view head (matrix SRV-02). Guarded
    // because reconfigure runs on every relaunch with unchanged access.
    if (
      args.project_path !== undefined &&
      (patch.is_private !== conv.is_private ||
        (patch.team_id !== undefined && patch.team_id !== conv.team_id))
    ) {
      await advanceCommentsAccessRevision(ctx, conv);
    }
    if (unparkToHost)
      await supersedeCloudSpawns(ctx, conv.user_id, args.conversation_id);
    // The folder moved under a park: the cloud_spawn a laptop may already be
    // running was chosen for (and would place) the OLD repo — supersede it and
    // ask again with a fresh token.
    const pathChanged =
      args.project_path !== undefined && args.project_path !== priorProjectPath;
    const updated = { ...conv, ...patch };
    const daemonAgentType = fromConvexAgentType(updated.agent_type);
    const stampedModelKey =
      args.model !== undefined
        ? launchModelOpt?.cliAlias
          ? launchModelOpt.key
          : undefined
        : launchModelKeyOf(reconfAgent, updated.model);
    const launch = {
      conversationId: args.conversation_id,
      agentType: daemonAgentType,
      projectPath: updated.project_path || updated.git_root,
      gitRoot: updated.git_root,
      sessionId: updated.session_id,
      ...(stampedModelKey ? { model: stampedModelKey } : {}),
      ...(updated.effort && launchCfg?.efforts.includes(updated.effort)
        ? { effort: updated.effort }
        : {}),
      ...(args.stable_mode ? { stableMode: args.stable_mode } : {}),
      ...(args.stable_exclude?.length
        ? { stableExclude: args.stable_exclude }
        : {}),
      callerUserId: userId,
    };
    if (args.cloud_device_id) {
      // A row the host already PLACED (it holds a worktree there): the same
      // folder re-launches as a plain start on the host; another folder would
      // orphan a running worktree, so it is refused rather than re-parked.
      // A shared row holds the main checkout the same way (cloud_checkout_path).
      const holdsCheckout =
        !!conv.worktree_path ||
        (conv.cloud_workspace === "shared" && !!conv.cloud_checkout_path);
      const placed =
        holdsCheckout &&
        conv.owner_device_id === args.cloud_device_id &&
        !conv.cloud_placement;
      if (placed) {
        if (
          args.project_path !== undefined &&
          args.project_path !== priorProjectPath
        ) {
          throw new Error(
            "This session is already placed on the host — start a new session for another folder",
          );
        }
        await enqueueStartSession(ctx, conv.user_id, {
          ...launch,
          targetDeviceId: args.cloud_device_id,
        });
        return;
      }
      await parkOnCloudHost(ctx, conv.user_id, updated, args.cloud_device_id, {
        projectPath: updated.project_path,
        gitRoot: updated.git_root,
        force: pathChanged,
        workspace: args.cloud_workspace,
        startFrom: args.cloud_start_from,
      });
      return;
    }
    if (hostTarget && !unparkToHost) {
      await parkOnCloudHost(ctx, conv.user_id, updated, hostTarget.device_id, {
        projectPath: updated.project_path,
        gitRoot: updated.git_root,
        force: pathChanged,
      });
      return;
    }
    await enqueueStartSession(ctx, conv.user_id, {
      ...launch,
      isolated: args.isolated,
      targetDeviceId: args.target_device_id ?? null,
    });
    if (
      args.project_path === undefined &&
      targetChanged &&
      !syncLogDisabled() &&
      !syncAckReceipts(ctx).some(
        (receipt: { entity_type: string; entity_id: string }) =>
          receipt.entity_type === "conversations" &&
          receipt.entity_id === conv._id,
      )
    )
      await ctx.db.patch(conv._id, { owner_device_id: conv.owner_device_id });
  },
};

export const reconfigureSession = mutation(reconfigureSessionDefinition);

export const reconfigureSessionCore = reconfigureSessionDefinition.handler;

/** The launch option key a conversation's stamped model names ("claude-opus"
 *  → "opus"), or undefined when the stamp is no launchable option and the
 *  launch should fall back to the user's default. */
export function launchModelKeyOf(
  agentType: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!model) return undefined;
  const agentKey = modelAgentKey(agentType || "claude_code");
  const key =
    agentKey === "claude" && model.startsWith("claude-")
      ? model.slice("claude-".length)
      : model;
  return AGENT_MODEL_CONFIG[agentKey]?.models.some(
    (o) => o.key === key && o.cliAlias,
  )
    ? key
    : undefined;
}

const switchAgentType = v.union(
  v.literal("claude_code"),
  v.literal("codex"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("opencode"),
  v.literal("pi"),
  v.literal("grok"),
  v.literal("muse"),
  v.literal("antigravity"),
);

// Stay on THIS conversation: patch agent/model, drop a transcript divider, and
// (when the live process has to change) kill+reconstitute as the new agent.
// Forking is a different verb — forkFromMessage with target_agent_type.
export const switchSessionAgent = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    session: v.optional(v.string()),
    agent_type: v.optional(switchAgentType),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    let conv: Doc<"conversations"> | null = null;
    if (args.conversation_id) {
      conv = await ctx.db.get(args.conversation_id);
      if (conv && conv.user_id !== userId && conv.owner_user_id !== userId) {
        throw new Error("Not authorized");
      }
    } else if (args.session) {
      conv = await resolveCommandableSession(
        ctx,
        userId,
        args.session,
        "switch",
      );
    } else {
      throw new Error("conversation_id or session required");
    }
    if (!conv) throw new Error("Not found");
    // A hosted conversation never becomes a local agent session.
    const hostedRefusal = agentTypeChangeRefusal(
      conv.agent_type,
      "claude_code",
    );
    if (hostedRefusal) throw new Error(hostedRefusal);

    const prevAgent = conv.agent_type || "claude_code";
    const nextAgent = args.agent_type || prevAgent;
    const agentChanged = !!args.agent_type && args.agent_type !== prevAgent;
    const retryCodexSwitch =
      args.agent_type === "codex" && prevAgent === "codex";
    if (
      !agentChanged &&
      !retryCodexSwitch &&
      args.model === undefined &&
      args.effort === undefined
    ) {
      throw new Error("Nothing to switch");
    }

    // A switch on a session with history is a rebuild of that history as the
    // new agent (the daemon writes the target client's transcript from the
    // server copy). Refuse BEFORE stamping the row when the target cannot be
    // rebuilt — otherwise agent_type names an agent the daemon then fails to
    // launch, and every capability gate downstream (fork, model rail) reads
    // the lie while the old agent quietly resumes.
    const blank =
      (conv.message_count ?? 0) === 0 && conv.fork_status !== "copying";
    if (
      agentChanged &&
      !canSessionBecomeAgent(
        args.agent_type,
        blank ? 0 : Math.max(1, conv.message_count ?? 0),
      )
    ) {
      const label =
        AGENT_CLIENTS[fromConvexAgentType(args.agent_type)].displayName;
      throw new Error(
        `${label} cannot take over an existing session's history; start a new ${label} session instead`,
      );
    }

    const patch: Record<string, any> = { updated_at: Date.now() };
    if (agentChanged) {
      patch.agent_type = args.agent_type;
      patch.model = undefined;
      patch.effort = undefined;
    }
    const launchCfg = AGENT_MODEL_CONFIG[modelAgentKey(nextAgent)];
    const launchModelOpt = args.model
      ? findModelOption(nextAgent, args.model)
      : undefined;
    if (args.model !== undefined) {
      if (args.model !== "default" && !launchModelOpt)
        throw new Error(`Unknown model: ${args.model}`);
      patch.model =
        args.model === "default" || !launchModelOpt?.cliAlias
          ? undefined
          : modelAgentKey(nextAgent) === "claude"
            ? `claude-${launchModelOpt.key}`
            : launchModelOpt.key;
    }
    if (args.effort !== undefined) {
      if (args.effort === "default") {
        patch.effort = undefined;
      } else {
        if (!launchCfg?.efforts.includes(args.effort))
          throw new Error(`Unknown effort: ${args.effort}`);
        patch.effort = args.effort;
      }
    }

    await ctx.db.patch(conv._id, patch);
    const updated = { ...conv, ...patch } as Doc<"conversations">;
    const midSession = launchCfg?.midSession === true;
    const reconstitutes = !blank && (agentChanged || !midSession);

    if (blank) {
      const daemonAgentType = fromConvexAgentType(nextAgent);
      const stampedModelKey =
        args.model !== undefined
          ? launchModelOpt?.cliAlias
            ? launchModelOpt.key
            : undefined
          : undefined;
      await enqueueStartSession(ctx, conv.user_id, {
        conversationId: conv._id,
        agentType: daemonAgentType,
        projectPath: updated.project_path || updated.git_root,
        gitRoot: updated.git_root,
        sessionId: updated.session_id,
        ...(stampedModelKey ? { model: stampedModelKey } : {}),
        ...(updated.effort && launchCfg?.efforts.includes(updated.effort)
          ? { effort: updated.effort }
          : {}),
      });
      return {
        ...sessionCommandResult(updated),
        switched: true,
        blank: true,
        reconstituted: false,
      };
    }

    if (reconstitutes) {
      if (!retryCodexSwitch) {
        const notice = formatAgentSwitchNotice({
          toAgent: nextAgent,
          fromAgent: prevAgent,
          toModel: args.model ?? (agentChanged ? undefined : conv.model),
          fromModel: agentChanged
            ? conv.model
            : args.model !== undefined
              ? conv.model
              : undefined,
        });
        await ctx.db.insert("messages", {
          conversation_id: conv._id,
          role: "user",
          content: notice,
          subtype: "agent_switch",
          message_uuid: crypto.randomUUID(),
          timestamp: Date.now(),
          ...navPromptField({
            role: "user",
            content: notice,
            subtype: "agent_switch",
          }),
        });
        await ctx.db.patch(conv._id, {
          message_count: (conv.message_count ?? 0) + 1,
          last_message_role: "user",
          updated_at: Date.now(),
        });
      }
      if (!updated.session_id) throw new Error("No session to switch");
      await enqueueKillAndResume(ctx, conv.user_id, updated, {
        forceReconstitute: agentChanged || nextAgent === "codex",
        switchAgent: agentChanged || nextAgent === "codex",
        model: args.model ?? updated.model,
        effort: args.effort ?? updated.effort,
      });
      return {
        ...sessionCommandResult(updated),
        switched: true,
        reconstituted: true,
      };
    }

    // Same-provider live rail: stamp the row, then inject `/model` / `/effort`
    // so the running agent applies it. The slash echo is the divider.
    const liveCommands: string[] = [];
    if (args.model !== undefined) {
      const alias =
        args.model === "default" ? "default" : launchModelOpt?.cliAlias;
      if (alias) liveCommands.push(`/model ${alias}`);
    }
    if (args.effort !== undefined && args.effort !== "default") {
      liveCommands.push(`/effort ${args.effort}`);
    }
    for (const content of liveCommands) {
      await enqueuePendingMessage(ctx, updated, userId, {
        content,
        client_id: `switch-${crypto.randomUUID()}`,
      });
    }
    return {
      ...sessionCommandResult(updated),
      switched: true,
      reconstituted: false,
      live_commands: liveCommands,
    };
  },
});

export const switchSessionProject = mutation({
  args: {
    conversation_id: v.id("conversations"),
    project_path: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Both the kill and the relaunch are routed under the runner's account —
    // the session stays on the machine that runs it, whichever party asked
    // for the switch (paths are that machine's).
    const conv = await requireSessionCommandTarget(
      ctx,
      userId,
      args.conversation_id,
    );

    const now = Date.now();

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "kill_session",
      args: JSON.stringify({
        conversation_id: args.conversation_id,
        cause: "switch_project",
      }),
      created_at: now,
    });

    await ctx.db.patch(args.conversation_id, {
      project_path: args.project_path,
      git_root: args.project_path,
    });

    const daemonAgentType = fromConvexAgentType(conv.agent_type);
    await enqueueStartSession(ctx, conv.user_id, {
      conversationId: args.conversation_id,
      agentType: daemonAgentType,
      projectPath: args.project_path,
      gitRoot: args.project_path,
      createdAt: now + 1,
    });
  },
});
