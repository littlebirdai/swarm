import type Dexie from "dexie";

export function measureIndexedDB(db: Dexie) {
  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  const add = (counts: Map<string, number>, table: string, rows: number) =>
    counts.set(table, (counts.get(table) ?? 0) + rows);

  db.use({
    stack: "dbcore",
    level: 0,
    create(core) {
      return {
        table(name) {
          const table = core.table(name);
          return {
            ...table,
            async get(request) {
              const result = await table.get(request);
              add(reads, name, Number(result !== undefined));
              return result;
            },
            async getMany(request) {
              const result = await table.getMany(request);
              add(
                reads,
                name,
                result.filter((row) => row !== undefined).length,
              );
              return result;
            },
            async query(request) {
              const response = await table.query(request);
              add(reads, name, request.values ? response.result.length : 0);
              return response;
            },
            async openCursor(request) {
              const cursor = await table.openCursor(request);
              add(reads, name, 0);
              if (request.values && cursor) {
                const start = cursor.start.bind(cursor);
                cursor.start = (onNext) =>
                  start(() => {
                    add(reads, name, 1);
                    onNext();
                  });
              }
              return cursor;
            },
            count(request) {
              add(reads, name, 0);
              return table.count(request);
            },
            mutate(request) {
              const rows =
                request.type === "deleteRange"
                  ? Infinity
                  : request.type === "delete"
                    ? request.keys.length
                    : request.values.length;
              add(writes, name, rows);
              return table.mutate(request);
            },
          };
        },
      };
    },
  });

  return { reads, writes };
}
