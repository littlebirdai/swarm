import { unsubscribeResponse } from "@platform/email";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { BRAND } from "../emails/render";

export const EMAIL_UNSUBSCRIBE_PATH = "/cli/email/unsubscribe";

export const emailUnsubscribe = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result: { ok: boolean } = await ctx.runMutation(
    internal.emails.digest.unsubscribeByToken,
    { token },
  );
  return unsubscribeResponse({
    ok: result.ok,
    method: request.method,
    brand: BRAND,
    settingsUrl: `${BRAND.url}/settings/notifications`,
  });
});
