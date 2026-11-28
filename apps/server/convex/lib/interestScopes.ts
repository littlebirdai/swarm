import type { Id } from "../_generated/dataModel";
import type { ChangeScope } from "../changeLog";
import { accessStampFor, authorizedFor, heldKeysFor } from "./accessKeys";
import { teamHasFeature } from "./teamFeatureGuard";

export const MAX_HEADS_SCOPES = 64;

export function addHomeScope(
  scopes: string[],
  scope: ChangeScope,
  ownerScopeKey: string,
): void {
  if (
    typeof scope.home_scope !== "string" ||
    !scope.home_scope ||
    scopes.includes(scope.home_scope)
  ) {
    return;
  }
  const ws = scope.workspace;
  const isTeam = typeof ws === "string" && ws.startsWith("team:");
  if (isTeam || scope.home_scope === ownerScopeKey) {
    scopes.push(scope.home_scope);
  }
}

export async function canReadSyncScope(
  ctx: { db: any },
  userId: Id<"users">,
  heldKeys: ReadonlySet<string>,
  scopeKey: string,
): Promise<boolean> {
  if (!userId || !scopeKey) return false;
  if (heldKeys.has(scopeKey)) return true;
  const uid = String(userId);
  if (scopeKey.startsWith("dir:")) {
    const dirTeamId = ctx.db.normalizeId("teams", scopeKey.slice(4));
    if (!dirTeamId) return false;
    return heldKeys.has(`team:${dirTeamId}`);
  }
  if (scopeKey.startsWith("project:")) {
    const pid = ctx.db.normalizeId("projects", scopeKey.slice(8));
    const project = pid ? await ctx.db.get(pid) : null;
    if (!project) return false;
    return authorizedFor(
      await accessStampFor(ctx, "projects", project),
      uid,
      heldKeys,
    );
  }
  if (scopeKey.startsWith("channel:")) {
    const chId = ctx.db.normalizeId("chat_channels", scopeKey.slice(8));
    const channel = chId ? await ctx.db.get(chId) : null;
    if (!channel) return false;
    const ws = channel.workspace;
    if (typeof ws !== "string" || !ws) return false;
    if (channel.kind === "community") {
      return ws === "public";
    }
    if (ws.startsWith("restricted:")) {
      if (channel.kind !== "private" && channel.kind !== "dm") return false;
      const teamId = ctx.db.normalizeId("teams", String(channel.team_id));
      if (!teamId || !heldKeys.has(`team:${teamId}`)) return false;
      if (!(await teamHasFeature(ctx, teamId, "chat"))) return false;
      const member = await ctx.db
        .query("chat_channel_members")
        .withIndex("by_channel_user", (q: any) =>
          q.eq("channel_id", channel._id).eq("user_id", userId),
        )
        .first();
      return !!member;
    }
    if (!ws.startsWith("team:")) return false;
    if (!heldKeys.has(ws)) return false;
    if (
      channel.kind !== undefined &&
      channel.kind !== "public" &&
      channel.kind !== "agents"
    ) {
      return false;
    }
    const wsTeamId = ctx.db.normalizeId("teams", ws.slice(5));
    if (!wsTeamId) return false;
    return await teamHasFeature(ctx, wsTeamId, "chat");
  }
  return false;
}

export async function resolveHeadsScopes(
  ctx: { db: any },
  userId: Id<"users">,
  requestedScopes?: string[],
): Promise<{ heldKeys: Set<string>; scopes: Iterable<string> }> {
  if (requestedScopes && requestedScopes.length > MAX_HEADS_SCOPES) {
    throw new Error(`Too many sync scopes requested (max ${MAX_HEADS_SCOPES})`);
  }
  const heldKeys = await heldKeysFor(ctx, userId);
  if (!requestedScopes) {
    const defaults: string[] = [];
    for (const key of heldKeys) {
      defaults.push(key.startsWith("team:") ? `dir:${key.slice(5)}` : key);
    }
    return { heldKeys, scopes: defaults };
  }
  const allowed: string[] = [];
  const seen = new Set<string>();
  for (const scopeKey of requestedScopes) {
    if (seen.has(scopeKey)) continue;
    seen.add(scopeKey);
    if (await canReadSyncScope(ctx, userId, heldKeys, scopeKey)) {
      allowed.push(scopeKey);
    }
  }
  return { heldKeys, scopes: allowed };
}
