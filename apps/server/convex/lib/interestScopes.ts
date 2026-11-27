import type { Id } from "../_generated/dataModel";
import type { ChangeScope } from "../changeLog";
import { canOwnerOrTeamAccess } from "../privacy";
import {
  accessStampFor,
  authorizedFor,
  heldKeysFor,
  interestScopesEnabled,
} from "./accessKeys";
import { teamHasFeature } from "./teamFeatureGuard";

export function addHomeScope(
  scopes: string[],
  scope: ChangeScope,
  ownerScopeKey: string,
): void {
  if (
    !interestScopesEnabled() ||
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
  if (heldKeys.has(scopeKey)) return true;
  if (!interestScopesEnabled()) return false;
  const uid = String(userId);
  if (scopeKey.startsWith("dir:")) {
    return heldKeys.has(`team:${scopeKey.slice(4)}`);
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
  if (scopeKey.startsWith("session:")) {
    const cid = ctx.db.normalizeId("conversations", scopeKey.slice(8));
    const conv = cid ? await ctx.db.get(cid) : null;
    if (!conv) return false;
    return await canOwnerOrTeamAccess(ctx, userId, conv);
  }
  if (scopeKey.startsWith("channel:")) {
    const chId = ctx.db.normalizeId("chat_channels", scopeKey.slice(8));
    const channel = chId ? await ctx.db.get(chId) : null;
    if (!channel) return false;
    if (channel.kind === "community") return true;
    if (!heldKeys.has(`team:${String(channel.team_id)}`)) return false;
    if (!(await teamHasFeature(ctx, channel.team_id, "chat"))) return false;
    if (channel.kind === "private" || channel.kind === "dm") {
      const member = await ctx.db
        .query("chat_channel_members")
        .withIndex("by_channel_user", (q: any) =>
          q.eq("channel_id", channel._id).eq("user_id", userId),
        )
        .first();
      return !!member;
    }
    return true;
  }
  return false;
}

export async function resolveHeadsScopes(
  ctx: { db: any },
  userId: Id<"users">,
  requestedScopes?: string[],
): Promise<{ heldKeys: Set<string>; scopes: Iterable<string> }> {
  const heldKeys = await heldKeysFor(ctx, userId);
  if (!requestedScopes || !interestScopesEnabled()) {
    return { heldKeys, scopes: heldKeys };
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
