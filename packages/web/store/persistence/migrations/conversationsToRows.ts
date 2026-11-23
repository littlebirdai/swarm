import type { Transaction } from "dexie";

export async function conversationsToRows(tx: Transaction): Promise<void> {
  const meta = tx.table("meta");
  const legacy = await meta.get("conversations");
  if (!legacy) return;

  const rows = Object.values(legacy.value ?? {});
  if (rows.length) await tx.table("conversations").bulkPut(rows);
  await meta.delete("conversations");
}
