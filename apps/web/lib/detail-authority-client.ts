import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConvexHttpClient } from "convex/browser";
import type { DetailAuthorityReader } from "../store/doc-detail-authority";
import { authPrincipal } from "./authPrincipal";
import { readDurableAuthValue } from "./durableAuthStorage";
import { AUTH_JWT_STORAGE_KEY, CONVEX_URL } from "./localAuth";

export function detailAuthorityReader(
  principal: string,
): DetailAuthorityReader {
  async function authenticatedClient() {
    const token = await readDurableAuthValue(AUTH_JWT_STORAGE_KEY);
    if (!token || authPrincipal.current() !== principal)
      throw new Error("Document cache authority changed");
    const client = new ConvexHttpClient(CONVEX_URL);
    client.setAuth(token);
    const user = await client.query(api.users.getCurrentUser);
    if (
      String(user?._id ?? "") !== principal ||
      authPrincipal.current() !== principal
    )
      throw new Error("Document cache identity is unverified");
    return client;
  }

  return {
    async detail(id) {
      return (await authenticatedClient()).query(
        api.taskMining.webGetDocDetail,
        { id },
      );
    },
    async page(workspace, cursor) {
      const scope = workspace.startsWith("team:")
        ? {
            workspace: "team" as const,
            team_id: workspace.slice(5) as Id<"teams">,
          }
        : workspace === `user:${principal}`
          ? { workspace: "personal" as const }
          : null;
      if (!scope) throw new Error("Invalid document cache workspace");
      return (await authenticatedClient()).query(api.docs.webListPaginated, {
        ...scope,
        paginationOpts: { numItems: 24, cursor },
      });
    },
  };
}
