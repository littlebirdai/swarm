import { api as _api } from "@codecast/convex/convex/_generated/api";
import { awaitReplayResult, checkReplaySignal } from "./inbox-replay-lane";
import { queryWithSignal } from "../lib/queryWithSignal";
import { useInboxStore, type InboxSession } from "../store/inboxStore";

const api = _api as any;

export type Collection = "sessions" | "tasks" | "docs" | "plans" | "projects";

export const BYIDS_CHUNK = 300;

export function chunkIds(
  ids: string[],
  size: number = BYIDS_CHUNK,
): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size)
    chunks.push(ids.slice(i, i + size));
  return chunks;
}

export async function queryReplay(
  convex: any,
  query: any,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  checkReplaySignal(signal);
  if (!signal) return convex.query(query, args);
  if (typeof convex.watchQuery === "function")
    return queryWithSignal(convex, query, args, signal);
  return awaitReplayResult(convex.query(query, args), signal);
}

async function batchGetChunk(
  convex: any,
  coll: Collection,
  ids: string[],
  signal?: AbortSignal,
): Promise<any[]> {
  switch (coll) {
    case "sessions":
      return (
        (
          await queryReplay(
            convex,
            api.inboxShelves.getInboxSessionsByIds,
            { ids },
            signal,
          )
        )?.sessions ?? []
      );
    case "tasks":
      return (
        (await queryReplay(convex, api.tasks.webGetByIds, { ids }, signal))
          ?.items ?? []
      );
    case "docs":
      return (
        (await queryReplay(convex, api.docs.webGetByIds, { ids }, signal))
          ?.docs ?? []
      );
    case "plans":
      return (
        (await queryReplay(convex, api.plans.webGetByIds, { ids }, signal)) ??
        []
      );
    case "projects":
      return (
        (await queryReplay(
          convex,
          api.projects.webGetByIds,
          { ids },
          signal,
        )) ?? []
      );
  }
}

export async function batchGet(
  convex: any,
  coll: Collection,
  ids: string[],
  signal?: AbortSignal,
): Promise<any[]> {
  if (!ids.length) return [];
  const rows: any[] = [];
  for (const chunk of chunkIds(ids)) {
    rows.push(...(await batchGetChunk(convex, coll, chunk, signal)));
  }
  return rows;
}

export async function settleDisownClaims(
  convex: any,
  ids: string[],
  signal?: AbortSignal,
): Promise<void> {
  const viewer = useInboxStore.getState().currentUser?._id;
  const rows = await batchGet(convex, "sessions", ids, signal);
  const store = useInboxStore.getState();
  if (signal?.aborted || viewer !== store.currentUser?._id) return;
  if (rows.length)
    store.syncTable(
      "sessions",
      rows as unknown as InboxSession[],
      { isDelta: true } as any,
    );
  const present = new Set(rows.map((r: any) => String(r._id)));
  const missing = new Set(ids.filter((id) => !present.has(id)));
  store.clearDisownedClaims([...missing]);
  if ([...missing].some((id) => store.liveInboxIds.has(id))) {
    store.setLiveInboxIds(
      [...store.liveInboxIds].filter((id) => !missing.has(id)),
    );
  }
}
