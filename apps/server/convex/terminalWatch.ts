import { v } from "convex/values";
import {
  isValidPaneTarget,
  PANE_MAX_FRAME_BYTES,
} from "@codecast/daemon/terminalStream";
import { query, mutation, internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getUserOrToken, requireUser, requireUserOrToken } from "./lib/auth";
import { runnerDeviceOf } from "./lib/runnerDevice";
import { canTeamMemberAccess, teamReadLevel } from "./privacy";
import { resolveReachableRunnerDevice } from "./devices";

const MAX_VIEWERS = 24;
const LEASE_MS = 50_000;
const RENEW_MS = 19_000;
const STREAM_STALE_MS = 12_000;
const DISPATCH_MS = 60_000;

type Share = Doc<"terminal_watch_shares">;
type Viewer = Doc<"terminal_watch_viewers">;
type ReadCtx = Pick<QueryCtx, "db">;

const conversationArg = { conversation_id: v.id("conversations") };
const leaseArgs = { ...conversationArg, share: v.id("terminal_watch_shares") };

function shareFor(ctx: ReadCtx, conversationId: Id<"conversations">) {
  return ctx.db
    .query("terminal_watch_shares")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", conversationId),
    )
    .unique();
}

function viewersFor(ctx: ReadCtx, share: Id<"terminal_watch_shares">) {
  return ctx.db
    .query("terminal_watch_viewers")
    .withIndex("by_share_user", (q) => q.eq("share", share));
}

function screenFor(ctx: ReadCtx, share: Id<"terminal_watch_shares">) {
  return ctx.db
    .query("terminal_watch_screens")
    .withIndex("by_share", (q) => q.eq("share", share))
    .unique();
}

async function removeShare(ctx: MutationCtx, share: Share) {
  const screen = await screenFor(ctx, share._id);
  if (screen) await ctx.db.delete(screen._id);
  for (const viewer of await viewersFor(ctx, share._id).collect()) {
    await ctx.db.delete(viewer._id);
  }
  await ctx.db.delete(share._id);
}

async function currentPane(ctx: ReadCtx, conversation: Doc<"conversations">) {
  const device = (await runnerDeviceOf(
    ctx,
    conversation,
  )) as Doc<"devices"> | null;
  if (!device) return null;
  const session = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversation._id),
    )
    .unique();
  const target = session?.tmux_session;
  if (
    !session ||
    session.user_id !== device.user_id ||
    session.hosted ||
    session.backend === "sdk" ||
    session.hibernated_at ||
    !target ||
    !isValidPaneTarget(target)
  )
    return null;
  return { device, session, target };
}

async function currentShare(
  ctx: ReadCtx,
  conversation: Doc<"conversations">,
  share: Share,
) {
  if (
    conversation.user_id !== share.owner_id ||
    conversation.team_id !== share.team_id ||
    conversation.session_id !== share.session_id ||
    conversation.team_visibility === "private"
  )
    return false;
  const pane = await currentPane(ctx, conversation);
  return (
    !!pane &&
    pane.device._id === share.device &&
    pane.session._id === share.session &&
    pane.target === share.target &&
    pane.session.agent_started_at === share.agent_started_at
  );
}

async function canWatch(
  ctx: ReadCtx,
  viewer: Id<"users">,
  conversation: Doc<"conversations">,
) {
  return (
    viewer !== conversation.user_id &&
    conversation.team_visibility !== "private" &&
    (await canTeamMemberAccess(ctx, viewer, conversation)) &&
    !(await resolveReachableRunnerDevice(ctx, viewer, conversation))
  );
}

async function viewerLease(
  ctx: ReadCtx,
  viewer: Id<"users">,
  args: {
    conversation_id: Id<"conversations">;
    share: Id<"terminal_watch_shares">;
  },
) {
  const share = await ctx.db.get(args.share);
  if (!share || share.conversation_id !== args.conversation_id) return null;
  const conversation = await ctx.db.get(args.conversation_id);
  if (
    !conversation ||
    !(await canWatch(ctx, viewer, conversation)) ||
    !(await currentShare(ctx, conversation, share))
  )
    return null;
  const presence = await ctx.db
    .query("terminal_watch_viewers")
    .withIndex("by_share_user", (q) =>
      q.eq("share", share._id).eq("user_id", viewer),
    )
    .unique();
  return { share, presence };
}

export const status = query({
  args: conversationArg,
  handler: async (ctx, args) => {
    const user = await getUserOrToken(ctx);
    if (!user) return null;
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation?.team_id) return null;
    const share = await shareFor(ctx, conversation._id);
    if (user === conversation.user_id) {
      const pane = await currentPane(ctx, conversation);
      if (!pane && !share) return null;
      return {
        role: "owner" as const,
        enabled: !!share,
        available:
          !!pane &&
          conversation.team_visibility !== "private" &&
          (await teamReadLevel(ctx, conversation)) === "content",
      };
    }
    if (
      !share ||
      !(await canWatch(ctx, user, conversation)) ||
      !(await currentShare(ctx, conversation, share))
    )
      return null;
    const presence = await ctx.db
      .query("terminal_watch_viewers")
      .withIndex("by_share_user", (q) =>
        q.eq("share", share._id).eq("user_id", user),
      )
      .unique();
    return presence?.revoked
      ? null
      : { role: "viewer" as const, share: share._id };
  },
});

export const setSharing = mutation({
  args: { ...conversationArg, enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== user) return false;
    const existing = await shareFor(ctx, conversation._id);
    if (!args.enabled) {
      if (existing) await removeShare(ctx, existing);
      return true;
    }

    const pane = await currentPane(ctx, conversation);
    if (
      !pane ||
      !conversation.team_id ||
      conversation.team_visibility === "private" ||
      (await teamReadLevel(ctx, conversation)) !== "content"
    )
      return false;
    if (existing && (await currentShare(ctx, conversation, existing)))
      return true;
    if (existing) await removeShare(ctx, existing);
    await ctx.db.insert("terminal_watch_shares", {
      conversation_id: conversation._id,
      team_id: conversation.team_id,
      owner_id: user,
      device: pane.device._id,
      session: pane.session._id,
      session_id: conversation.session_id,
      target: pane.target,
      agent_started_at: pane.session.agent_started_at,
    });
    return true;
  },
});

export const watchers = query({
  args: conversationArg,
  handler: async (ctx, args) => {
    const user = await getUserOrToken(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!user || !conversation || conversation.user_id !== user) return [];
    const share = await shareFor(ctx, conversation._id);
    if (!share || !(await currentShare(ctx, conversation, share))) return [];
    const now = Date.now();
    const watchers = await Promise.all(
      (await viewersFor(ctx, share._id).collect())
        .filter((viewer) => !viewer.revoked && viewer.expires_at > now)
        .map(async (viewer) => {
          if (!(await canWatch(ctx, viewer.user_id, conversation))) return null;
          const account = await ctx.db.get(viewer.user_id);
          return {
            user_id: viewer.user_id,
            name: account?.name ?? "Teammate",
            expires_at: viewer.expires_at,
          };
        }),
    );
    return watchers.filter((watcher) => watcher !== null);
  },
});

export const stopViewer = mutation({
  args: { ...conversationArg, viewer: v.id("users") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== user) return false;
    const share = await shareFor(ctx, conversation._id);
    if (!share) return false;
    const viewer = await ctx.db
      .query("terminal_watch_viewers")
      .withIndex("by_share_user", (q) =>
        q.eq("share", share._id).eq("user_id", args.viewer),
      )
      .unique();
    if (!viewer) return false;
    await ctx.db.patch(viewer._id, { revoked: true });
    return true;
  },
});

export const watch = mutation({
  args: { ...leaseArgs, renew: v.boolean() },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const lease = await viewerLease(ctx, viewer, args);
    if (!lease) return false;
    const { share, presence } = lease;
    const now = Date.now();
    if (
      presence?.revoked ||
      (args.renew && (!presence || presence.expires_at <= now))
    )
      return false;

    if (!presence) {
      const viewers = await viewersFor(ctx, share._id).collect();
      const retained = viewers.filter(
        (row) => row.revoked || row.expires_at > now,
      );
      if (retained.length >= MAX_VIEWERS) return false;
      for (const row of viewers) {
        if (!row.revoked && row.expires_at <= now) await ctx.db.delete(row._id);
      }
      await ctx.db.insert("terminal_watch_viewers", {
        share: share._id,
        user_id: viewer,
        expires_at: now + LEASE_MS,
        revoked: false,
      });
    } else if (presence.expires_at <= now + LEASE_MS - RENEW_MS) {
      await ctx.db.patch(presence._id, { expires_at: now + LEASE_MS });
    }

    const screen = await screenFor(ctx, share._id);
    if (
      !screen ||
      (now - (screen.seen_at ?? 0) > STREAM_STALE_MS &&
        now - screen.requested_at >= DISPATCH_MS)
    ) {
      const device = await ctx.db.get(share.device);
      if (!device) return false;
      const stream_id = crypto.randomUUID();
      await ctx.db.insert("daemon_commands", {
        user_id: share.owner_id,
        target_device_id: device.device_id,
        command: "stream_pane",
        args: JSON.stringify({
          team_watch: {
            target: share.target,
            share: share._id,
            stream_id,
            pane_instance: share.pane_instance,
          },
        }),
        created_at: now,
      });
      if (screen) await ctx.db.delete(screen._id);
      await ctx.db.insert("terminal_watch_screens", {
        share: share._id,
        stream_id,
        requested_at: now,
        expires_at: now + DISPATCH_MS,
      });
    }
    return true;
  },
});

export const screen = query({
  args: leaseArgs,
  handler: async (ctx, args) => {
    const user = await getUserOrToken(ctx);
    const lease = user && (await viewerLease(ctx, user, args));
    if (
      !lease ||
      !lease.presence ||
      lease.presence.revoked ||
      lease.presence.expires_at <= Date.now()
    )
      return null;
    const screen = await screenFor(ctx, lease.share._id);
    const seenAt = screen?.seen_at ?? null;
    return {
      text:
        seenAt !== null && seenAt + STREAM_STALE_MS > Date.now()
          ? (screen?.frame ?? null)
          : null,
      seen_at: seenAt,
      expires_at: lease.presence.expires_at,
    };
  },
});

export const cliPush = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    share: v.id("terminal_watch_shares"),
    stream_id: v.string(),
    pane_instance: v.optional(v.string()),
    frame: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUserOrToken(ctx, args.api_token);
    const share = await ctx.db.get(args.share);
    if (!share) return { stop: true };
    const screen = await screenFor(ctx, share._id);
    if (!screen || screen.stream_id !== args.stream_id) return { stop: true };
    const device = await ctx.db.get(share.device);
    if (
      !device ||
      device.device_id !== args.device_id ||
      device.user_id !== user
    )
      return { stop: true };

    const conversation = await ctx.db.get(share.conversation_id);
    if (
      !conversation ||
      !(await currentShare(ctx, conversation, share)) ||
      (await teamReadLevel(ctx, conversation)) !== "content"
    ) {
      await removeShare(ctx, share);
      return { stop: true };
    }
    if (
      !args.pane_instance ||
      (share.pane_instance && share.pane_instance !== args.pane_instance)
    ) {
      await removeShare(ctx, share);
      return { stop: true };
    }
    const now = Date.now();
    const viewers = await viewersFor(ctx, share._id).collect();
    let watched = false;
    for (const viewer of viewers) {
      if (
        !viewer.revoked &&
        viewer.expires_at > now &&
        (await canWatch(ctx, viewer.user_id, conversation))
      ) {
        watched = true;
        break;
      }
    }
    if (!watched) {
      await ctx.db.delete(screen._id);
      return { stop: true };
    }

    if (!share.pane_instance)
      await ctx.db.patch(share._id, { pane_instance: args.pane_instance });
    await ctx.db.patch(screen._id, {
      seen_at: now,
      expires_at: now + DISPATCH_MS,
      ...(args.frame !== undefined
        ? { frame: args.frame.slice(0, PANE_MAX_FRAME_BYTES) }
        : {}),
    });
    return { stop: false };
  },
});

export const pruneExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows: Viewer[] = await ctx.db
      .query("terminal_watch_viewers")
      .withIndex("by_expiry", (q) =>
        q.eq("revoked", false).lte("expires_at", Date.now()),
      )
      .take(500);
    for (const row of rows) await ctx.db.delete(row._id);
    const screens = await ctx.db
      .query("terminal_watch_screens")
      .withIndex("by_expiry", (q) => q.lte("expires_at", Date.now()))
      .take(500);
    for (const screen of screens) await ctx.db.delete(screen._id);
  },
});
