import { v } from "convex/values";
import {
  PANE_MAX_PENDING_INPUT_BYTES,
  isValidPaneTarget,
} from "@codecast/daemon/terminalStream";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./functions";
import { getUserOrToken, requireUser } from "./lib/auth";
import {
  claim,
  clearTerminalClaim,
  findClaim,
  nextTerminalControl,
  release as releaseClaim,
  renew as renewClaim,
  revoke as revokeClaim,
  terminalTypingEnabled,
  type TerminalAccess,
  withHeldClaim,
} from "./lib/claims";
import { terminalPublisher } from "./lib/terminalPublisher";
import { canTeamMemberAccess, isTeamMember } from "./privacy";

type ReadCtx = Pick<QueryCtx, "db">;
type TerminalState = NonNullable<Doc<"claims">["terminal"]>;
type Grant = Doc<"terminal_typing_grants">;
type PaneArgs = { conversation_id: Id<"conversations">; pane_instance: number };
type LeaseArgs = PaneArgs & { token: number };

const stale = { status: "stale" } as const;
const disabled = { status: "disabled" } as const;
const conversationArgs = { conversation_id: v.id("conversations") };
const paneArgs = { ...conversationArgs, pane_instance: v.number() };
const leaseArgs = { ...paneArgs, token: v.number() };
const machineArgs = {
  ...paneArgs,
  api_token: v.string(),
  device_id: v.string(),
  agent_started_at: v.number(),
};

const resource = (id: Id<"conversations">) => ({
  kind: "terminal" as const,
  id,
});
const claimUse = (args: LeaseArgs, holder: Id<"users">) => ({
  resource: {
    ...resource(args.conversation_id),
    paneInstance: args.pane_instance,
  },
  holder,
  token: args.token,
});

async function currentPane(ctx: ReadCtx, id: Id<"conversations">) {
  const conversation = await ctx.db.get(id);
  if (!conversation?.owner_device_id || conversation.inbox_killed_at)
    return null;
  const [device, sessions] = await Promise.all([
    ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) =>
        q
          .eq("user_id", conversation.user_id)
          .eq("device_id", conversation.owner_device_id!),
      )
      .first(),
    ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", id))
      .take(2),
  ]);
  const [session] = sessions;
  const target = session?.tmux_session;
  if (
    !device ||
    sessions.length !== 1 ||
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
  return {
    conversation,
    device,
    session,
    target,
    agent_started_at: session.agent_started_at ?? session.started_at,
  };
}

type Pane = NonNullable<Awaited<ReturnType<typeof currentPane>>>;

function matchesBinding(terminal: TerminalState, pane: Pane) {
  return (
    terminal.device === pane.device._id &&
    terminal.session === pane.session._id &&
    terminal.target === pane.target &&
    terminal.agent_started_at === pane.agent_started_at
  );
}

async function reportedPane(ctx: ReadCtx, args: PaneArgs) {
  const [pane, row] = await Promise.all([
    currentPane(ctx, args.conversation_id),
    findClaim(ctx.db, resource(args.conversation_id)),
  ]);
  const terminal = row?.terminal;
  return pane &&
    row &&
    terminal?.open &&
    row.pane_instance === args.pane_instance &&
    matchesBinding(terminal, pane)
    ? { pane, row, terminal }
    : null;
}

function grantFor(ctx: ReadCtx, id: Id<"conversations">, user: Id<"users">) {
  return ctx.db
    .query("terminal_typing_grants")
    .withIndex("by_conversation_user", (q) =>
      q.eq("conversation_id", id).eq("user_id", user),
    )
    .unique();
}

async function typingAccess(
  ctx: ReadCtx,
  pane: Pane,
  terminal: TerminalState,
  user: Id<"users">,
): Promise<TerminalAccess | null> {
  const { conversation, device, session, target } = pane;
  if (device.user_id === user) return {};
  if (!conversation.team_id || !terminal.watch_pane_instance) return null;
  const grant = await grantFor(ctx, conversation._id, user);
  if (
    !grant ||
    grant.owner_id !== device.user_id ||
    grant.device !== device._id ||
    grant.team_id !== conversation.team_id
  )
    return null;
  const membership = await ctx.db.get(grant.membership);
  if (
    membership?.user_id !== user ||
    membership.team_id !== grant.team_id ||
    !(await canTeamMemberAccess(ctx, user, conversation)) ||
    !(await isTeamMember(ctx, device.user_id, grant.team_id))
  )
    return null;
  const share = await ctx.db
    .query("terminal_watch_shares")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", conversation._id),
    )
    .unique();
  if (
    !share?.bound_at ||
    share.pane_instance !== terminal.watch_pane_instance ||
    share.owner_id !== device.user_id ||
    share.team_id !== grant.team_id ||
    share.device !== device._id ||
    share.session !== session._id ||
    share.session_id !== conversation.session_id ||
    share.target !== target
  )
    return null;
  const blocked = await ctx.db
    .query("terminal_watch_blocks")
    .withIndex("by_conversation_user", (q) =>
      q.eq("conversation_id", conversation._id).eq("user_id", user),
    )
    .first();
  if (blocked) return null;
  const viewer = await ctx.db
    .query("terminal_watch_viewers")
    .withIndex("by_share_user", (q) =>
      q.eq("share", share._id).eq("user_id", user),
    )
    .unique();
  return viewer && !viewer.revoked && viewer.expires_at > Date.now()
    ? { viewer: viewer._id, grant: grant._id }
    : null;
}

function sameAccess(access: TerminalAccess, terminal: TerminalState) {
  return access.viewer === terminal.viewer && access.grant === terminal.grant;
}

async function canUseLease(
  ctx: ReadCtx,
  pane: Pane,
  terminal: TerminalState,
  user: Id<"users">,
) {
  const access = await typingAccess(ctx, pane, terminal, user);
  return !!access && sameAccess(access, terminal);
}

export const setTypingGrant = mutation({
  args: { ...conversationArgs, user_id: v.id("users"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return false;
    const owner = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (conversation?.user_id !== owner || args.user_id === owner) return false;
    const prior = await grantFor(ctx, args.conversation_id, args.user_id);
    if (!args.enabled) {
      if (prior) await ctx.db.delete(prior._id);
      const row = await findClaim(ctx.db, resource(args.conversation_id));
      if (row?.holder === args.user_id) await clearTerminalClaim(ctx, row);
      return true;
    }

    const pane = await currentPane(ctx, args.conversation_id);
    if (
      !pane ||
      pane.device.user_id !== owner ||
      !conversation.team_id ||
      !(await isTeamMember(ctx, owner, conversation.team_id)) ||
      !(await canTeamMemberAccess(ctx, args.user_id, conversation))
    )
      return false;
    const teamId = conversation.team_id;
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) =>
        q.eq("user_id", args.user_id).eq("team_id", teamId),
      )
      .first();
    if (!membership) return false;
    const grant: Omit<Grant, "_id" | "_creationTime"> = {
      conversation_id: conversation._id,
      team_id: conversation.team_id,
      owner_id: owner,
      user_id: args.user_id,
      membership: membership._id,
      device: pane.device._id,
      granted_at: Date.now(),
    };
    if (!prior) await ctx.db.insert("terminal_typing_grants", grant);
    else if (
      prior.owner_id !== grant.owner_id ||
      prior.device !== grant.device ||
      prior.membership !== grant.membership ||
      prior.team_id !== grant.team_id
    )
      await ctx.db.replace(prior._id, grant);
    return true;
  },
});

export const status = query({
  args: conversationArgs,
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return null;
    const user = await getUserOrToken(ctx);
    if (!user) return null;
    const row = await findClaim(ctx.db, resource(args.conversation_id));
    if (row?.pane_instance === undefined || !row.terminal?.open) return null;
    const pane = await currentPane(ctx, args.conversation_id);
    if (!pane || !matchesBinding(row.terminal, pane)) return null;
    const access = await typingAccess(ctx, pane, row.terminal, user);
    if (!access) return null;
    const remainingMs = Math.max(0, row.lease_until - Date.now());
    const token =
      row.holder === user && remainingMs > 0 && sameAccess(access, row.terminal)
        ? row.token
        : null;
    return {
      pane_instance: row.pane_instance,
      current_token: row.token,
      token,
      ready:
        token !== null && row.terminal.ack_sequence === row.terminal.sequence,
      busy: !!row.holder && remainingMs > 0,
      remainingMs,
    };
  },
});

export const focus = mutation({
  args: { ...paneArgs, request_id: v.string(), expected_token: v.number() },
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return disabled;
    const holder = await requireUser(ctx);
    const found = await reportedPane(ctx, args);
    if (!found) return stale;
    const { row, pane, terminal } = found;
    const access = await typingAccess(ctx, pane, terminal, holder);
    if (!access) return { status: "forbidden" as const };
    if (args.request_id.length > 128)
      return { status: "invalid_request" as const };

    if (
      row.holder &&
      !(row.holder === holder
        ? sameAccess(access, terminal)
        : await canUseLease(ctx, pane, terminal, row.holder))
    )
      await clearTerminalClaim(ctx, row);

    const result = await claim(ctx, {
      ...resource(args.conversation_id),
      holder,
      paneInstance: args.pane_instance,
      requestId: args.request_id,
      expectedToken: args.expected_token,
      ...access,
    });
    if (result.status === "held" && result.token !== row.token) {
      await ctx.scheduler.runAfter(
        result.remainingMs,
        internal.terminalInput.expire,
        {
          conversation_id: args.conversation_id,
          pane_instance: args.pane_instance,
          token: result.token,
        },
      );
    }
    return result;
  },
});

export const renew = mutation({
  args: leaseArgs,
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return stale;
    const user = await requireUser(ctx);
    const found = await reportedPane(ctx, args);
    if (!found || !(await canUseLease(ctx, found.pane, found.terminal, user)))
      return stale;
    const result = await renewClaim(ctx, claimUse(args, user));
    return result.status === "held" ? result : stale;
  },
});

async function stopLease(ctx: MutationCtx, args: LeaseArgs, byOwner: boolean) {
  if (!terminalTypingEnabled()) return stale;
  const user = await requireUser(ctx);
  const row = await findClaim(ctx.db, resource(args.conversation_id));
  if (!row?.holder || row.pane_instance !== args.pane_instance) return stale;
  if (!byOwner && row.holder !== user) return stale;
  if (byOwner && (await ctx.db.get(args.conversation_id))?.user_id !== user)
    return stale;
  const use = claimUse(args, row.holder);
  const result = byOwner
    ? await revokeClaim(ctx, {
        resource: use.resource,
        targetHolder: use.holder,
        token: use.token,
      })
    : await releaseClaim(ctx, use);
  return result.status === "cleared" ? result : stale;
}

export const release = mutation({
  args: leaseArgs,
  handler: (ctx, args) => stopLease(ctx, args, false),
});
export const revoke = mutation({
  args: leaseArgs,
  handler: (ctx, args) => stopLease(ctx, args, true),
});

export const expire = internalMutation({
  args: leaseArgs,
  handler: async (ctx, args): Promise<void> => {
    const row = await findClaim(ctx.db, resource(args.conversation_id));
    if (
      !row?.holder ||
      row.token !== args.token ||
      row.pane_instance !== args.pane_instance
    )
      return;
    const remaining = row.lease_until - Date.now();
    if (remaining > 0)
      await ctx.scheduler.runAfter(
        remaining,
        internal.terminalInput.expire,
        args,
      );
    else await clearTerminalClaim(ctx, row);
  },
});

export const send = mutation({
  args: { ...leaseArgs, data: v.string() },
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return stale;
    const user = await getUserOrToken(ctx);
    const found = user && (await reportedPane(ctx, args));
    if (
      !user ||
      !found ||
      !(await canUseLease(ctx, found.pane, found.terminal, user))
    )
      return stale;
    const { row, terminal } = found;
    const result = await withHeldClaim(ctx, claimUse(args, user), async () => {
      if (terminal.ack_sequence !== terminal.sequence)
        return { status: "not_ready" as const };
      if (
        !args.data ||
        args.data.length > PANE_MAX_PENDING_INPUT_BYTES * 2 ||
        args.data.length % 2 !== 0 ||
        !/^[0-9a-f]+$/.test(args.data)
      )
        return { status: "invalid_input" as const };
      const pending_input = (terminal.pending_input ?? "") + args.data;
      if (pending_input.length > PANE_MAX_PENDING_INPUT_BYTES * 2)
        return { status: "backlog" as const };
      await ctx.db.patch(row._id, { terminal: { ...terminal, pending_input } });
      return { status: "accepted" as const };
    });
    return result.status === "held" ? result.value : stale;
  },
});

async function machinePane(
  ctx: ReadCtx,
  args: {
    conversation_id: Id<"conversations">;
    api_token: string;
    device_id: string;
    agent_started_at: number;
  },
) {
  const publisher = await terminalPublisher(
    ctx,
    args.api_token,
    args.device_id,
  );
  if (!publisher) return null;
  const pane = await currentPane(ctx, args.conversation_id);
  return pane?.device.user_id === publisher &&
    pane.device.device_id === args.device_id &&
    pane.agent_started_at === args.agent_started_at
    ? pane
    : null;
}

export const cliReportPane = mutation({
  args: {
    ...machineArgs,
    observation: v.union(v.literal("started"), v.literal("ended")),
    watch_pane_instance: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return disabled;
    const pane = await machinePane(ctx, args);
    if (
      !pane ||
      !Number.isSafeInteger(args.pane_instance) ||
      args.pane_instance < 1 ||
      (args.watch_pane_instance?.length ?? 0) > 256
    )
      return stale;

    const row = await findClaim(ctx.db, resource(args.conversation_id));
    const old = row?.terminal;
    const last = row?.pane_instance ?? 0;
    const ended = args.observation === "ended";
    if (
      args.pane_instance < last ||
      (ended &&
        (args.pane_instance !== last || !old || !matchesBinding(old, pane)))
    )
      return { ...stale, last_pane_instance: last };
    if (
      args.pane_instance === last &&
      (!old || !matchesBinding(old, pane) || (!ended && !old.open))
    )
      return { ...stale, last_pane_instance: last };

    const ok = {
      status: "ok" as const,
      last_pane_instance: args.pane_instance,
    };
    if (args.pane_instance === last && old) {
      if (ended && old.open && row) {
        await ctx.db.patch(row._id, {
          holder: undefined,
          lease_until: 0,
          terminal: {
            ...nextTerminalControl(old),
            open: false,
            ended_at: row.holder ? Date.now() : old.ended_at,
          },
        });
      }
      if (
        !ended &&
        args.watch_pane_instance &&
        args.watch_pane_instance !== old.watch_pane_instance &&
        row
      ) {
        if (old.watch_pane_instance) return stale;
        await ctx.db.patch(row._id, {
          terminal: { ...old, watch_pane_instance: args.watch_pane_instance },
        });
      }
      return ok;
    }

    const incoming = {
      pane_instance: args.pane_instance,
      holder: undefined,
      lease_until: 0,
      terminal: {
        device: pane.device._id,
        session: pane.session._id,
        target: pane.target,
        agent_started_at: pane.agent_started_at,
        watch_pane_instance: args.watch_pane_instance,
        open: true,
        sequence: (old?.sequence ?? 0) + 1,
      },
    };
    if (row) await ctx.db.patch(row._id, incoming);
    else
      await ctx.db.insert("claims", {
        conversation_id: args.conversation_id,
        kind: "terminal",
        token: 0,
        ...incoming,
      });
    return ok;
  },
});

export const cliPoll = mutation({
  args: {
    ...machineArgs,
    ack: v.optional(
      v.object({ sequence: v.number(), token: v.union(v.number(), v.null()) }),
    ),
  },
  handler: async (ctx, args) => {
    if (!terminalTypingEnabled()) return disabled;
    const pane = await machinePane(ctx, args);
    if (!pane) return stale;
    const row = await findClaim(ctx.db, resource(args.conversation_id));
    if (
      !row?.terminal?.open ||
      row.pane_instance !== args.pane_instance ||
      !matchesBinding(row.terminal, pane)
    )
      return stale;
    let terminal = row.terminal;
    let token = row.holder ? row.token : null;
    if (
      row.holder &&
      (row.lease_until <= Date.now() ||
        !(await canUseLease(ctx, pane, terminal, row.holder)))
    ) {
      await clearTerminalClaim(ctx, row);
      terminal = nextTerminalControl(terminal);
      token = null;
    }
    const control = {
      pane_instance: args.pane_instance,
      sequence: terminal.sequence,
      token,
    };
    if (
      args.ack &&
      (args.ack.sequence !== control.sequence || args.ack.token !== token)
    )
      return stale;

    const ack_sequence = args.ack?.sequence ?? terminal.ack_sequence;
    const data =
      token !== null && ack_sequence === control.sequence
        ? terminal.pending_input
        : undefined;
    if (ack_sequence !== terminal.ack_sequence || data) {
      await ctx.db.patch(row._id, {
        terminal: {
          ...terminal,
          ack_sequence,
          pending_input: data ? undefined : terminal.pending_input,
        },
      });
    }
    return {
      status: "ok" as const,
      control,
      ...(data && token !== null
        ? { input: { pane_instance: args.pane_instance, token, data } }
        : {}),
    };
  },
});
