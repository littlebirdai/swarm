import type { JournalBridge } from "./journal-bridge";

export async function findArchiveRestores(
  journal: Pick<JournalBridge, "loadOutbox">,
  archive?: {
    accountId: string;
    dispatchedAt: number;
  },
): Promise<Set<string>> {
  const restores = new Set<string>();
  if (!archive) return restores;
  try {
    for (const entry of await journal.loadOutbox()) {
      if (
        entry.action === "restoreArchivedDoc" &&
        (!entry.accountId || entry.accountId === archive.accountId) &&
        entry.ts >= archive.dispatchedAt &&
        typeof entry.args?.[0] === "string"
      ) {
        restores.add(entry.args[0]);
      }
    }
  } catch {}
  return restores;
}

export async function findPendingArchives(
  journal: Pick<JournalBridge, "loadOutbox">,
  principal: string,
): Promise<Set<string>> {
  const archives = new Set<string>();
  try {
    for (const entry of await journal.loadOutbox()) {
      if (entry.accountId !== undefined && entry.accountId !== principal)
        continue;
      const id = Array.isArray(entry.args) ? entry.args[0] : undefined;
      if (typeof id !== "string") continue;
      if (entry.action === "archiveDoc") archives.add(id);
      if (entry.action === "restoreArchivedDoc") archives.delete(id);
    }
  } catch {}
  return archives;
}

export function stripPendingArchives(
  result: Record<string, any> | null,
  archives: Set<string> | null,
  docDetailWorkspaces: Map<string, string | undefined>,
): Record<string, any> | null {
  if (!result || !archives?.size || !result.docDetails) return result;
  const nextDocDetails: Record<string, any> = {};
  for (const [id, row] of Object.entries(result.docDetails)) {
    if (archives.has(id)) {
      const ws = (row as { workspace?: unknown } | undefined)?.workspace;
      docDetailWorkspaces.set(id, typeof ws === "string" ? ws : undefined);
      continue;
    }
    nextDocDetails[id] = row;
  }
  const copy = { ...result };
  if (Object.keys(nextDocDetails).length > 0) {
    copy.docDetails = nextDocDetails;
  } else {
    delete copy.docDetails;
  }
  return Object.keys(copy).length ? copy : null;
}
