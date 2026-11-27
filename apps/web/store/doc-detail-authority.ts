import { useInboxStore } from "./inboxStore";
import { withCacheEvictions } from "./cache-eviction";
import {
  detailAccountIsCurrent,
  detailInvalidationRevision,
  detailReadIsCurrent,
  detailReadPosition,
  invalidateDetailReads,
  reportDetailInvalidation,
  setDetailInvalidationReporter,
  type DetailInvalidation,
} from "./doc-detail-cache";
import {
  deleteInvalidatedDocDetails,
  persistedDocDetailWorkspace,
  readCachedDocDetails,
} from "./doc-detail-disk";

type CachedDetail = { _id: string; workspace?: string; updated_at?: number };

function pendingCreate(id: string): boolean {
  const { pending } = useInboxStore.getState();
  return (
    pending[`docs:${id}`]?.type === "include" ||
    pending[`docDetails:${id}`]?.type === "include"
  );
}

export function hideInvalidatedDetails(ids?: readonly string[]): number {
  const store = useInboxStore.getState();
  const targets = (ids ?? Object.keys(store.docDetails)).filter(
    (id) => !pendingCreate(id),
  );
  const revision = invalidateDetailReads(ids ? targets : undefined);
  withCacheEvictions(
    targets.flatMap((id) =>
      store.docDetails[id]
        ? [{ key: "docDetails", id, observed: store.docDetails[id] }]
        : [],
    ),
    () => store.dropRows("docDetails", targets),
  );
  return revision;
}

export async function persistDetailInvalidation(
  ids: readonly string[],
  current: () => boolean,
): Promise<string[]> {
  if (!current()) return [];
  const targets = ids.filter((id) => !pendingCreate(id));
  if (!targets.length) return [];
  const docs = useInboxStore.getState().docs;
  const revision = hideInvalidatedDetails(targets);
  return deleteInvalidatedDocDetails(targets, (id) => {
    const state = useInboxStore.getState();
    return (
      current() &&
      !pendingCreate(id) &&
      detailInvalidationRevision(id) === revision &&
      (state.docs[id] === undefined || state.docs[id] === docs[id]) &&
      state.docDetails[id] === undefined
    );
  });
}

export async function collectCompleteDocCrawlAbsences(
  workspace: string,
  live: ReadonlySet<string>,
  position: ReturnType<typeof detailReadPosition>,
): Promise<void> {
  const state = useInboxStore.getState();
  const disk = await readCachedDocDetails();
  const cached = new Map<string, CachedDetail>();
  for (const row of disk) cached.set(row._id, row);
  for (const row of Object.values(state.docDetails)) cached.set(row._id, row);
  const ids = [...cached.values()]
    .filter(
      (row) =>
        !live.has(row._id) &&
        (row.workspace === undefined || row.workspace === workspace) &&
        detailReadIsCurrent(row._id, position),
    )
    .map((row) => row._id);
  reportDetailInvalidation({ ids, cause: "crawl", workspace });
}

export function persistedDetailScope(id: string): string | undefined {
  return (
    useInboxStore.getState().docDetails[id]?.workspace ??
    persistedDocDetailWorkspace(id)
  );
}

type DetailRow = {
  _id: string;
  workspace?: string;
  archived_at?: number;
  updated_at?: number;
} & Record<string, unknown>;
export type DetailAuthorityReader = {
  detail: (id: string) => Promise<DetailRow | null>;
  page: (
    workspace: string,
    cursor: string | null,
  ) => Promise<{
    page: Array<{ _id: string }>;
    isDone: boolean;
    continueCursor: string;
  }>;
};

export async function verifyDetailInvalidation(
  reader: DetailAuthorityReader,
  evidence: DetailInvalidation,
  current: () => boolean,
): Promise<string[]> {
  const read = detailReadPosition();
  const ids = [...new Set(evidence.ids)].filter((id) => !pendingCreate(id));
  if (evidence.cause === "crawl") {
    if (!evidence.workspace) return [];
    const workspace = evidence.workspace;
    const candidates = ids.filter((id) => {
      const scope = persistedDetailScope(id);
      return scope === undefined || scope === workspace;
    });
    const absent = new Set(candidates);
    let cursor: string | null = null;
    let complete = false;
    for (let page = 0; current() && absent.size && page < 1000; page++) {
      const next = await reader.page(workspace, cursor);
      for (const row of next.page) absent.delete(String(row._id));
      if (next.isDone) {
        complete = true;
        break;
      }
      if (!next.continueCursor || next.continueCursor === cursor) return [];
      cursor = next.continueCursor;
    }
    if (!complete || !current()) return [];
    const confirmed = await Promise.all(
      [...absent].map(async (id) => {
        const detail = await reader.detail(id);
        return !detail || detail.archived_at !== undefined ? id : null;
      }),
    );
    return current()
      ? confirmed.filter(
          (id): id is string => id !== null && detailReadIsCurrent(id, read),
        )
      : [];
  }
  const confirmed = await Promise.all(
    ids.map(async (id) => {
      const row = await reader.detail(id);
      const invalid =
        row === null ||
        (evidence.cause === "archive" && row.archived_at !== undefined);
      return invalid && detailReadIsCurrent(id, read) ? id : null;
    }),
  );
  return current() ? confirmed.filter((id): id is string => id !== null) : [];
}

export function startLocalDocAuthority(
  authority: DetailAuthorityReader,
): () => void {
  const account = detailReadPosition();
  let active = true;
  const current = () => active && detailAccountIsCurrent(account);
  setDetailInvalidationReporter(
    (evidence) => {
      if (!current()) return false;
      if (evidence.cause !== "crawl") hideInvalidatedDetails(evidence.ids);
      void verifyDetailInvalidation(authority, evidence, current)
        .then((ids) => persistDetailInvalidation(ids, current))
        .catch(() => {});
      return true;
    },
    authority.detail,
    collectCompleteDocCrawlAbsences,
  );
  return () => {
    active = false;
    setDetailInvalidationReporter();
  };
}
