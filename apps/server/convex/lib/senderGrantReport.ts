import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { canOwnerOrTeamAccess } from "../privacy";
import {
  decideSenderGrant,
  senderGrantReportEnabled,
  type SenderGrantMachineKind,
} from "./sender-grant.rules";

type DbCtx = { db: any };

type TargetConversation = {
  _id?: Id<"conversations">;
  user_id: Id<"users">;
  team_id?: Id<"teams">;
  agent_type?: string;
  owner_device_id?: string | null;
  execution_protocol_state?: string;
  migration?: { to_device_id: string };
  is_private?: boolean;
  team_visibility?: string;
  share_token?: string;
  started_at?: number;
};

async function resolveEffectiveTarget(
  ctx: DbCtx,
  conversation: TargetConversation,
): Promise<{
  runnerId: Id<"users">;
  deviceId: string | undefined;
  isMoving: boolean;
}> {
  if (conversation.migration) {
    return {
      runnerId: conversation.user_id,
      deviceId: conversation.migration.to_device_id || undefined,
      isMoving: true,
    };
  }
  if (conversation._id && conversation.execution_protocol_state !== undefined) {
    const head = await ctx.db
      .query("conversation_execution_heads")
      .withIndex("by_conversation", (q: any) =>
        q.eq("conversation_id", conversation._id),
      )
      .first();
    const move = head?.device_move;
    if (move) {
      if (move.replacement) {
        return {
          runnerId: move.replacement.destination_runner_id,
          deviceId: move.replacement.destination_device_id || undefined,
          isMoving: true,
        };
      }
      if (move.phase !== "aborting") {
        return {
          runnerId: move.destination_runner_id,
          deviceId: move.destination_device_id || undefined,
          isMoving: true,
        };
      }
    }
  }
  return {
    runnerId: conversation.user_id,
    deviceId: conversation.owner_device_id ?? undefined,
    isMoving: false,
  };
}

type EffectiveTarget = {
  runnerId: Id<"users">;
  deviceId: string | undefined;
  isMoving: boolean;
};

async function isLinkVisitorSender(
  ctx: DbCtx,
  fromUserId: Id<"users">,
  conversation: TargetConversation,
): Promise<boolean> {
  if (!conversation.share_token || !conversation._id) return false;
  const redemption = await ctx.db
    .query("share_redemptions")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversation._id).eq("user_id", fromUserId),
    )
    .first();
  if (redemption?.token !== conversation.share_token) return false;
  return !(await canOwnerOrTeamAccess(ctx, fromUserId, {
    ...conversation,
    is_private: conversation.is_private ?? true,
  }));
}

export async function resolveTargetMachineKind(
  ctx: DbCtx,
  conversation: TargetConversation,
  resolvedTarget?: EffectiveTarget,
): Promise<SenderGrantMachineKind> {
  if (isHostedAgentType(conversation.agent_type)) return "hosted";

  const { runnerId, deviceId, isMoving } =
    resolvedTarget ?? (await resolveEffectiveTarget(ctx, conversation));

  const runner = await ctx.db.get(runnerId);
  if (runner?.is_bot && runner.team_id) return "team";

  if (deviceId) {
    const teamMember = await ctx.db
      .query("team_host_members")
      .withIndex("by_user_device", (q: any) =>
        q.eq("user_id", runnerId).eq("device_id", deviceId),
      )
      .first();
    if (teamMember && teamMember.status === "ready") return "team";

    const adminHost = await ctx.db
      .query("team_hosts")
      .withIndex("by_admin_device", (q: any) =>
        q.eq("admin_user_id", runnerId).eq("admin_device_id", deviceId),
      )
      .first();
    if (adminHost) return "team";

    const castMachine = await ctx.db
      .query("cast_machines")
      .withIndex("by_device", (q: any) =>
        q.eq("user_id", runnerId).eq("device_id", deviceId),
      )
      .first();
    if (castMachine) return "hosted";

    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) =>
        q.eq("user_id", runnerId).eq("device_id", deviceId),
      )
      .first();
    if (device) {
      return device.is_remote || device.cloud_host ? "hosted" : "personal";
    }

    if (isMoving) return "unknown";

    return "personal";
  }

  if (isMoving) return "unknown";

  const castMachine = await ctx.db
    .query("cast_machines")
    .withIndex("by_user", (q: any) => q.eq("user_id", runnerId))
    .first();
  if (
    castMachine &&
    conversation._id &&
    Array.isArray(castMachine.held_conversation_ids) &&
    castMachine.held_conversation_ids.some(
      (id: Id<"conversations">) => String(id) === String(conversation._id),
    )
  ) {
    return "hosted";
  }

  return "personal";
}

export async function reportSenderGrantIfNeeded(
  ctx: {
    db: any;
    scheduler?: {
      runAfter: (delayMs: number, fn: any, args: any) => Promise<unknown>;
    };
  },
  conversation: any,
  fromUserId: Id<"users">,
  fields: {
    from_conversation_id?: Id<"conversations">;
    origin?: string;
    human?: boolean;
    skip_sender_grant_report?: boolean;
  },
): Promise<void> {
  if (!senderGrantReportEnabled()) return;
  if (fields.skip_sender_grant_report) return;
  if (isHostedAgentType(conversation.agent_type)) return;
  if (
    conversation.execution_protocol_state === undefined &&
    String(fromUserId) === String(conversation.user_id)
  ) {
    return;
  }

  try {
    const target = await resolveEffectiveTarget(ctx, conversation);
    if (String(fromUserId) === String(target.runnerId)) return;

    if (await isLinkVisitorSender(ctx, fromUserId, conversation)) return;

    const machineKind = await resolveTargetMachineKind(
      ctx,
      conversation,
      target,
    );
    if (machineKind === "hosted" || machineKind === "team") return;

    const isAgentSender =
      fields.from_conversation_id !== undefined ||
      fields.origin === "scheduler" ||
      fields.human === false ||
      Boolean((await ctx.db.get(fromUserId))?.is_bot);

    const decision = decideSenderGrant({
      machineKind,
      senderIsOwner: false,
      senderKind: isAgentSender ? "agent" : "teammate",
      hasGrant: false,
    });
    if (!decision.shouldReport || !ctx.scheduler) return;

    await ctx.scheduler.runAfter(0, internal.analytics.capture, {
      event: "sender_grant_report",
      distinctId: String(fromUserId),
      properties: {
        conversation_id: String(conversation._id),
        sender_kind: decision.senderKind,
        reason: decision.reason,
      },
    });
  } catch {}
}
