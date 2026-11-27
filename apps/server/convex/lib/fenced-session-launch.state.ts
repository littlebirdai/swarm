import {
  deviceWakesOnUse,
  isReservedDevice,
} from "@codecast/cloud-hosts/cloudPlacement";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { findModelOption } from "@codecast/agent-clients/agentClients";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DEVICE_ONLINE_MS } from "../deviceRouting";
import { ownDevice, resolveOwnerDevice } from "../devices";
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
