import type { QueryCtx } from "../_generated/server";
import { verifyApiToken } from "../apiTokens";

export async function terminalPublisher(
  ctx: Pick<QueryCtx, "db">,
  token: string,
  deviceId: string,
) {
  const auth = await verifyApiToken(ctx, token, false);
  if (!auth) return null;
  const credential = await ctx.db.get(auth.tokenId);
  return credential?.device_id === deviceId ? auth.userId : null;
}
