const BY_KIND: Readonly<Record<string, readonly string[]>> = {
  dir: [
    "tasks",
    "docs",
    "plans",
    "projects",
    "chatMessages",
    "docDetails",
    "taskComments",
  ],
  project: ["tasks", "docs", "plans", "docDetails", "taskComments"],
  channel: ["chatMessages"],
};

export function sweptCollectionsFor(scopes: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const scope of scopes)
    for (const key of BY_KIND[scope.split(":")[0]] ?? []) out.add(key);
  return [...out];
}

export function revokedFeedKeys(
  feeds: Record<string, unknown>,
  scopes: ReadonlySet<string>,
): string[] {
  return Object.keys(feeds).filter((key) =>
    scopes.has(`dir:${key.split("|")[0]}`),
  );
}
