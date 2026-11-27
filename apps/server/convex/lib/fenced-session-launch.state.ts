import {
  deviceWakesOnUse,
  isReservedDevice,
} from "@codecast/cloud-hosts/cloudPlacement";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { findModelOption } from "@codecast/agent-clients/agentClients";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DEVICE_ONLINE_MS } from "../deviceRouting";
import { enqueueStartSession, ownDevice, resolveOwnerDevice } from "../devices";
import { initializeFencedExecutionInDb } from "../executionBindings";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./execution-binding.validators";
import { registeredDaemonBoot } from "./execution-daemon.state";

export async function enrollFreshOwnedCodex(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  launch: {
    project_path?: string;
    git_root?: string;
    target_device_id?: string;
    isolated?: boolean;
    worktree_name?: string;
    stable_mode?: string;
    stable_exclude?: string[];
    model?: string;
    effort?: string;
  },
  now: number,
): Promise<boolean> {
  if (
    process.env.CODECAST_FENCED_NEW_SESSIONS_V1 !== "1" ||
    process.env.CODECAST_EDGE_DELIVERY_V1 !== "1" ||
    process.env.SWARM_TURN_BATON !== "1" ||
    !launch.project_path?.trim() ||
    launch.isolated ||
    launch.worktree_name ||
    launch.stable_mode ||
    launch.stable_exclude?.length
  )
    return false;
  const target = await resolveOwnerDevice(ctx, userId, {
    projectPath: launch.project_path,
    gitRoot: launch.git_root,
    targetDeviceId: launch.target_device_id,
  });
  if (!target) return false;
  const device = await ownDevice(ctx, userId, target);
  if (
    !device ||
    device.is_remote ||
    isReservedDevice(device) ||
    deviceWakesOnUse(device) ||
    now - device.last_seen >= DEVICE_ONLINE_MS
  )
    return false;

  const boot = await registeredDaemonBoot(ctx, userId, target);
  if (!boot?.owned_codex_new_sessions) return false;

  const defaultModel =
    launch.model ?? (await ctx.db.get(userId))?.default_models?.codex;
  const model =
    defaultModel && findModelOption("codex", defaultModel)?.cliAlias;
  await initializeFencedExecutionInDb(ctx, userId, {
    conversationId,
    now,
    target: {
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: launch.project_path,
      model: model || undefined,
      effort: launch.effort,
      configurationRevision: 1,
      ownerDeviceId: target,
      daemonBootId: boot.daemon_boot_id,
      requiredCapabilities: [
        ...EXECUTION_PROTOCOL_CAPABILITIES,
        STEER_BATON_CAPABILITY,
      ],
      protocolVersion: 1,
    },
  });
  return true;
}

export async function launchDispatchedSession(
  ctx: Pick<MutationCtx, "db">,
  args: {
    userId: Id<"users">;
    runnerUserId: Id<"users">;
    conversationId: Id<"conversations">;
    daemonType: Parameters<typeof enqueueStartSession>[2]["agentType"];
    projectPath?: string;
    gitRoot?: string;
    createdAt: number;
    model?: string;
    effort?: string;
    definition?: Parameters<typeof enqueueStartSession>[2]["definition"];
    handThread: boolean;
    opts: {
      isolated?: boolean;
      worktree_name?: string;
      target_device_id?: string;
      stable_mode?: string;
      stable_exclude?: string[];
    };
  },
): Promise<void> {
  const {
    userId,
    runnerUserId,
    conversationId,
    daemonType,
    projectPath,
    gitRoot,
    createdAt,
    model,
    effort,
    definition,
    handThread,
    opts,
  } = args;
  if (
    daemonType === "codex" &&
    runnerUserId === userId &&
    !definition &&
    !handThread &&
    (await enrollFreshOwnedCodex(
      ctx,
      userId,
      conversationId,
      { ...opts, project_path: projectPath, git_root: gitRoot, model, effort },
      createdAt,
    ))
  )
    return;
  await enqueueStartSession(ctx, runnerUserId, {
    conversationId,
    agentType: daemonType,
    projectPath,
    gitRoot,
    createdAt,
    callerUserId: userId,
    ...(opts.isolated ? { isolated: true } : {}),
    ...(opts.worktree_name ? { worktreeName: opts.worktree_name } : {}),
    ...(opts.target_device_id ? { targetDeviceId: opts.target_device_id } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(opts.stable_mode ? { stableMode: opts.stable_mode } : {}),
    ...(opts.stable_exclude?.length
      ? { stableExclude: opts.stable_exclude }
      : {}),
    ...(definition ? { definition } : {}),
  });
}

type FreshLaunch = Parameters<typeof enqueueStartSession>[2];

export async function enrollLocalCodexLaunch(
  ctx: Pick<MutationCtx, "db">,
  runner: Id<"users">,
  start: FreshLaunch,
): Promise<boolean> {
  if (
    start.agentType !== "codex" ||
    (start.callerUserId && start.callerUserId !== runner) ||
    start.definition ||
    start.prompt
  )
    return false;

  return await enrollFreshOwnedCodex(
    ctx,
    runner,
    start.conversationId,
    {
      project_path: start.projectPath || start.gitRoot || undefined,
      git_root: start.gitRoot || undefined,
      target_device_id: start.targetDeviceId ?? undefined,
      isolated: start.isolated,
      worktree_name: start.worktreeName,
      stable_mode: start.stableMode,
      stable_exclude: start.stableExclude,
      model: start.model,
      effort: start.effort,
    },
    Date.now(),
  );
}

export async function enqueueFreshLocalSession(
  ctx: Pick<MutationCtx, "db">,
  runner: Id<"users">,
  start: FreshLaunch,
): Promise<void> {
  if (await enrollLocalCodexLaunch(ctx, runner, start)) return;
  await enqueueStartSession(ctx, runner, start);
}

export function launchPromptId(
  conversation: Doc<"conversations"> | null,
  source: string,
) {
  return conversation?.execution_protocol_state === "fenced"
    ? `launch:${source}:${conversation._id}`
    : undefined;
}
