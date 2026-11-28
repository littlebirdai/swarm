const STUB_COLLECTION: Readonly<Record<string, string>> = {
  createDoc: "docs",
  createPlan: "plans",
};

export function rejectCreateStubInDraft(
  draft: any,
  actionName: string,
  localResult: { stubId?: unknown },
): string[] | null {
  const key = STUB_COLLECTION[actionName];
  const stubId = localResult?.stubId;
  if (!key || typeof stubId !== "string") return null;
  delete draft[key]?.[stubId];
  delete draft.pending?.[`${key}:${stubId}`];
  return [key, "pending"];
}
