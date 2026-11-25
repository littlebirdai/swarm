type Entry = readonly [name: string, fingerprint: string];

export type Inventory = Entry[];

export function functionFingerprint(kind: string, visibility: string): string {
  return `${kind.toLowerCase()} ${visibility}`;
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function swarmSchemaInventory(schema: unknown): Inventory {
  const tables = (schema as { tables?: unknown } | null)?.tables;
  if (!Array.isArray(tables)) throw new Error("invalid schema table inventory");
  const inventory: Inventory = [];
  for (const table of tables) {
    if (typeof table?.tableName !== "string" || !table.tableName)
      throw new Error("invalid schema table name");
    inventory.push([`table:${table.tableName}`, ""]);
    for (const [field, kind, active] of [
      ["indexes", "database", true],
      ["stagedDbIndexes", "database", false],
      ["searchIndexes", "search", true],
      ["stagedSearchIndexes", "search", false],
      ["vectorIndexes", "vector", true],
      ["stagedVectorIndexes", "vector", false],
    ] as const) {
      const indexes = table[field] ?? [];
      if (!Array.isArray(indexes)) throw new Error(`invalid ${field}`);
      for (const index of indexes) {
        if (
          typeof index?.indexDescriptor !== "string" ||
          !index.indexDescriptor
        )
          throw new Error(`invalid index descriptor in ${field}`);
        const name = `index:${table.tableName}.${index.indexDescriptor}`;
        const fields = index.fields;
        const filters = index.filterFields;
        let definition: unknown;
        if (kind === "database" && strings(fields)) {
          definition =
            fields.at(-1) === "_creationTime" ? fields.slice(0, -1) : fields;
        } else if (
          kind === "search" &&
          typeof index.searchField === "string" &&
          strings(filters)
        ) {
          definition = [index.searchField, [...filters].sort()];
        } else if (
          kind === "vector" &&
          typeof index.vectorField === "string" &&
          Number.isSafeInteger(index.dimensions) &&
          index.dimensions > 0 &&
          strings(filters)
        ) {
          definition = [
            index.vectorField,
            index.dimensions,
            [...filters].sort(),
          ];
        } else {
          throw new Error(`invalid definition for ${name}`);
        }
        inventory.push([name, JSON.stringify([kind, active, definition])]);
      }
    }
  }
  return inventory;
}

function compatible(name: string, before: string, after: string): boolean {
  if (after === before) return true;
  if (name.startsWith("fn:"))
    return (
      before.endsWith(" internal") &&
      after === before.replace(/ internal$/, " public")
    );
  if (!name.startsWith("index:")) return false;
  const [oldKind, oldActive, oldFields] = JSON.parse(before);
  const [newKind, newActive, newFields] = JSON.parse(after);
  return (
    !oldActive &&
    newActive &&
    oldKind === newKind &&
    JSON.stringify(oldFields) === JSON.stringify(newFields)
  );
}

export function changedInventory(tree: Inventory, prod: Inventory): string[] {
  const entries = new Map<string, string[]>();
  for (const [name, fingerprint] of tree)
    entries.set(name, [...(entries.get(name) ?? []), fingerprint]);
  return prod.flatMap(([name, before]) => {
    const after = entries.get(name);
    return !after || after.some((entry) => compatible(name, before, entry))
      ? []
      : [name];
  });
}
