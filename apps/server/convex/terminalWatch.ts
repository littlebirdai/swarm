import { v } from "convex/values";
import {
  isValidPaneTarget,
  PANE_MAX_FRAME_BYTES,
} from "@codecast/daemon/terminalStream";
import { query, mutation, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getUserOrToken, requireUser } from "./lib/auth";
import { runnerDeviceOf } from "./lib/runnerDevice";
import { canTeamMemberAccess, isTeamMember, teamReadLevel } from "./privacy";
import { resolveReachableRunnerDevice } from "./devices";
import { terminalPublisher } from "./lib/terminalPublisher";
import {
  deleteTerminalShare,
  deleteTerminalViewer,
  terminalWatchScreen,
  terminalWatchViewers,
} from "./lib/terminalWatchRows";

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

function viewerBlocks(
  ctx: ReadCtx,
  conversation: Id<"conversations">,
  user: Id<"users">,
) {
  return ctx.db
    .query("terminal_watch_blocks")
    .withIndex("by_conversation_user", (q) =>
      q.eq("conversation_id", conversation).eq("user_id", user),
    );
}

async function currentPane(ctx: ReadCtx, conversation: Doc<"conversations">) {
  const device = (await runnerDeviceOf(
    ctx,
    conversation,
  )) as Doc<"devices"> | null;
  if (!device) return null;
  const sessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversation._id),
    )
    .take(2);
  if (sessions.length !== 1) return null;
  const session = sessions[0];
  const target = session?.tmux_session;
  if (
    !session ||
    session.user_id !== device.user_id ||
    session.hosted ||
    session.backend === "sdk" ||
    session.hibernated_at ||
    !target ||
    target.startsWith("%") ||
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
    conversation.team_visibility === "private" ||
    !(await isTeamMember(ctx, share.owner_id, share.team_id))
  )
    return false;
  const pane = await currentPane(ctx, conversation);
  return (
    !!pane &&
    pane.device._id === share.device &&
    pane.session._id === share.session &&
    pane.target === share.target
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
  if (
    !share?.bound_at ||
    !share.pane_instance ||
    share.conversation_id !== args.conversation_id
  )
    return null;
  const conversation = await ctx.db.get(share.conversation_id);
  if (
    !conversation ||
    !(await canWatch(ctx, viewer, conversation)) ||
    !(await currentShare(ctx, conversation, share)) ||
    (await viewerBlocks(ctx, conversation._id, viewer).first())
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
      const available =
        !!pane &&
        conversation.team_visibility !== "private" &&
        (await isTeamMember(ctx, user, conversation.team_id)) &&
        (await teamReadLevel(ctx, conversation)) === "content";
      const current =
        available && share && (await currentShare(ctx, conversation, share))
          ? share
          : null;
      const binding =
        !!current &&
        !current.bound_at &&
        (current.bind_expires_at ?? 0) > Date.now();
      return {
        role: "owner" as const,
        enabled: !!(current?.bound_at && current.pane_instance) || binding,
        ...(binding ? { binding: true } : {}),
        available,
      };
    }
    if (
      !share?.bound_at ||
      !share.pane_instance ||
      !(await canWatch(ctx, user, conversation)) ||
      !(await currentShare(ctx, conversation, share))
    )
      return null;
    return (await viewerBlocks(ctx, conversation._id, user).first())
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
      if (existing) await deleteTerminalShare(ctx.db, existing);
      return true;
    }

    const pane = await currentPane(ctx, conversation);
    if (
      !pane ||
      !conversation.team_id ||
      conversation.team_visibility === "private" ||
      !(await isTeamMember(ctx, user, conversation.team_id)) ||
      (await teamReadLevel(ctx, conversation)) !== "content"
    )
      return false;
    if (
      existing &&
      ((existing.bound_at && existing.pane_instance) ||
        (existing.bind_expires_at ?? 0) > Date.now()) &&
      (await currentShare(ctx, conversation, existing))
    )
      return true;
    if (existing) await deleteTerminalShare(ctx.db, existing);
    const share = await ctx.db.insert("terminal_watch_shares", {
      conversation_id: conversation._id,
      team_id: conversation.team_id,
      owner_id: user,
      device: pane.device._id,
      session: pane.session._id,
      session_id: conversation.session_id,
      target: pane.target,
      bind_expires_at: Date.now() + DISPATCH_MS,
    });
    await ctx.db.insert("daemon_commands", {
      user_id: user,
      target_device_id: pane.device.device_id,
      command: "stream_pane",
      args: JSON.stringify({
        team_watch: { target: pane.target, share, bind: true },
      }),
      created_at: Date.now(),
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
      (await terminalWatchViewers(ctx.db, share._id).collect())
        .filter((viewer) => !viewer.revoked && viewer.expires_at > now)
        .map(async (viewer) => {
          if (!(await canWatch(ctx, viewer.user_id, conversation))) return null;
          const account = await ctx.db.get(viewer.user_id);
          return {
            user_id: viewer.user_id,
            name: account?.name ?? "Teammate",
            expires_at: viewer.expires_at,
            remaining_ms: viewer.expires_at - now,
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
    if (!(await viewerBlocks(ctx, conversation._id, args.viewer).first())) {
      await ctx.db.insert("terminal_watch_blocks", {
        conversation_id: conversation._id,
        team_id: share.team_id,
        user_id: args.viewer,
      });
    }
    await deleteTerminalViewer(ctx.db, viewer);
    return true;
  },
});

export const blockedViewers = query({
  args: conversationArg,
  handler: async (ctx, args) => {
    const user = await getUserOrToken(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (
      !user ||
      !conversation?.team_id ||
      conversation.user_id !== user ||
      !(await isTeamMember(ctx, user, conversation.team_id))
    )
      return [];
    const blocks = await ctx.db
      .query("terminal_watch_blocks")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversation_id", conversation._id),
      )
      .collect();
    const users = new Set(blocks.map((block) => block.user_id));
    return await Promise.all(
      [...users].map(async (user_id) => ({
        user_id,
        name: (await ctx.db.get(user_id))?.name ?? "Teammate",
      })),
    );
  },
});

export const unblockViewer = mutation({
  args: { ...conversationArg, viewer: v.id("users") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== user) return false;
    for (const block of await viewerBlocks(
      ctx,
      conversation._id,
      args.viewer,
    ).collect())
      await ctx.db.delete(block._id);
    return true;
  },
});

export const leave = mutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const share = await ctx.db.get(args.share);
    if (!share || share.conversation_id !== args.conversation_id) return false;
    const presence = await ctx.db
      .query("terminal_watch_viewers")
      .withIndex("by_share_user", (q) =>
        q.eq("share", share._id).eq("user_id", viewer),
      )
      .collect();
    for (const row of presence) await deleteTerminalViewer(ctx.db, row);
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
      const viewers = await terminalWatchViewers(ctx.db, share._id).collect();
      const retained = viewers.filter(
        (row) => !row.revoked && row.expires_at > now,
      );
      if (retained.length >= MAX_VIEWERS) return false;
      for (const row of viewers) {
        if (row.revoked || row.expires_at <= now) await ctx.db.delete(row._id);
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

    const screen = await terminalWatchScreen(ctx.db, share._id);
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
    const screen = await terminalWatchScreen(ctx.db, lease.share._id);
    const seenAt = screen?.seen_at ?? null;
    return {
      text:
        seenAt !== null && seenAt + STREAM_STALE_MS > Date.now()
          ? (screen?.frame ?? null)
          : null,
      revision: seenAt,
      stale_in_ms: Math.max(0, (seenAt ?? 0) + STREAM_STALE_MS - Date.now()),
      expires_in_ms: lease.presence.expires_at - Date.now(),
    };
  },
});

const daemonArgs = {
  api_token: v.string(),
  device_id: v.string(),
  share: v.id("terminal_watch_shares"),
};

async function deviceShare(
  ctx: ReadCtx,
  args: {
    api_token: string;
    device_id: string;
    share: Id<"terminal_watch_shares">;
  },
) {
  const user = await terminalPublisher(ctx, args.api_token, args.device_id);
  if (!user) return null;
  const share = await ctx.db.get(args.share);
  if (!share || share.owner_id !== user) return null;
  const device = await ctx.db.get(share.device);
  return device?.device_id === args.device_id && device.user_id === user
    ? share
    : null;
}

export const cliBind = mutation({
  args: { ...daemonArgs, pane_instance: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const share = await deviceShare(ctx, args);
    if (!share || share.bound_at || (share.bind_expires_at ?? 0) <= Date.now())
      return false;
    const conversation = await ctx.db.get(share.conversation_id);
    if (
      !args.pane_instance ||
      !conversation ||
      !(await currentShare(ctx, conversation, share)) ||
      (await teamReadLevel(ctx, conversation)) !== "content"
    ) {
      await deleteTerminalShare(ctx.db, share);
      return false;
    }
    await ctx.db.patch(share._id, {
      pane_instance: args.pane_instance,
      bound_at: Date.now(),
      bind_expires_at: undefined,
    });
    return true;
  },
});

export const cliPush = mutation({
  args: {
    ...daemonArgs,
    stream_id: v.string(),
    pane_instance: v.optional(v.string()),
    frame: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const share = await deviceShare(ctx, args);
    if (!share?.bound_at || !share.pane_instance) return { stop: true };
    const screen = await terminalWatchScreen(ctx.db, share._id);
    if (!screen || screen.stream_id !== args.stream_id) return { stop: true };

    const conversation = await ctx.db.get(share.conversation_id);
    if (
      !conversation ||
      !(await currentShare(ctx, conversation, share)) ||
      (await teamReadLevel(ctx, conversation)) !== "content"
    ) {
      await deleteTerminalShare(ctx.db, share);
      return { stop: true };
    }
    if (!args.pane_instance || share.pane_instance !== args.pane_instance) {
      await deleteTerminalShare(ctx.db, share);
      return { stop: true };
    }
    const now = Date.now();
    const viewers = await terminalWatchViewers(ctx.db, share._id).collect();
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
    const expiredShares = await ctx.db
      .query("terminal_watch_shares")
      .withIndex("by_bind_expiry", (q) =>
        q.gt("bind_expires_at", 0).lte("bind_expires_at", Date.now()),
      )
      .take(50);
    for (const share of expiredShares) await deleteTerminalShare(ctx.db, share);
    const rows: Viewer[] = await ctx.db
      .query("terminal_watch_viewers")
      .withIndex("by_expiry", (q) =>
        q.eq("revoked", false).lte("expires_at", Date.now()),
      )
      .take(100);
    const revoked = await ctx.db
      .query("terminal_watch_viewers")
      .withIndex("by_expiry", (q) =>
        q.eq("revoked", true).lte("expires_at", Date.now()),
      )
      .take(100);
    for (const row of [...rows, ...revoked])
      await deleteTerminalViewer(ctx.db, row);
    const screens = await ctx.db
      .query("terminal_watch_screens")
      .withIndex("by_expiry", (q) => q.lte("expires_at", Date.now()))
      .take(500);
    for (const screen of screens) await ctx.db.delete(screen._id);
  },
});

export const purgeTeamRows = internalMutation({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.team_id);
    if (team && !team.deleted_at) return;
    const shares = await ctx.db
      .query("terminal_watch_shares")
      .withIndex("by_team", (q) => q.eq("team_id", args.team_id))
      .take(20);
    for (const share of shares) await deleteTerminalShare(ctx.db, share);
    const blocks = await ctx.db
      .query("terminal_watch_blocks")
      .withIndex("by_team", (q) => q.eq("team_id", args.team_id))
      .take(100);
    for (const block of blocks) {
      const conversation = await ctx.db.get(block.conversation_id);
      const nextTeam =
        conversation?.team_id !== args.team_id
          ? conversation?.team_id
          : undefined;
      const movedTo = nextTeam && (await ctx.db.get(nextTeam));
      if (movedTo && !movedTo.deleted_at)
        await ctx.db.patch(block._id, { team_id: movedTo._id });
      else await ctx.db.delete(block._id);
    }
    if (shares.length === 20 || blocks.length === 100)
      await ctx.scheduler.runAfter(
        0,
        internal.terminalWatch.purgeTeamRows,
        args,
      );
  },
});
