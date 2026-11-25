import type { QueryCtx } from "../_generated/server";
import { verifyApiToken } from "../apiTokens";

export async function terminalPublisher(
  ctx: Pick<QueryCtx, "db">,
  token: string,
  deviceId: string,
  allowUnbound = false,
) {
  const auth = await verifyApiToken(ctx, token, false);
  if (!auth) return null;
  const credential = await ctx.db.get(auth.tokenId);
  if (!credential) return null;
  return credential.device_id === deviceId ||
    (allowUnbound && !credential.device_id)
    ? auth.userId
    : null;
}
