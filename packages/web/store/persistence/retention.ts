// Large retention passes can take seconds. Separate batches let other writes
// use the table between deletes.
export const RETENTION_DELETE_BATCH = 2_000;

export async function deleteInBatches(
  table: { bulkDelete: (ids: string[]) => PromiseLike<unknown> },
  ids: string[],
  batch = RETENTION_DELETE_BATCH,
): Promise<void> {
  try {
    for (let i = 0; i < ids.length; i += batch) await table.bulkDelete(ids.slice(i, i + batch));
  } catch {
    // What is left on disk goes at the next boot's pass.
  }
}
