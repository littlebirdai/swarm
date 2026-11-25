import { AsyncLocalStorage } from "node:async_hooks";
import { convexTest } from "convex-test";
import {
  defineSchema,
  getFunctionName,
  type FunctionReference,
} from "convex/server";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import type { DatabaseReader } from "../convex/_generated/server";
import schema from "../convex/schema";
import { allModules } from "../convex/testModules.testkit";

type TransactionLimits = Parameters<typeof convexTest>[0]["transactionLimits"];

const testSchema = defineSchema(schema.tables);

const fixtureSeeds = new AsyncLocalStorage<Set<string>>();

export function claimFixtureSeed(seed: string) {
  const seeds = fixtureSeeds.getStore();
  if (!seeds) throw new Error("Create fixtures inside serverTest.run");
  if (seeds.has(seed)) throw new Error(`Fixture seed already used: ${seed}`);
  seeds.add(seed);
}

export function serverTest(transactionLimits?: TransactionLimits) {
  const t = convexTest({
    schema: testSchema,
    modules: allModules,
    transactionLimits,
  });
  const seeds = new Set<string>();
  return {
    ...t,
    run: ((handler) =>
      fixtureSeeds.run(seeds, () => t.run(handler))) satisfies typeof t.run,
  };
}

export type ServerTest = ReturnType<typeof serverTest>;

export function asUser(t: ServerTest, user: Id<"users">) {
  return t.withIdentity({ subject: `${user}|test-session` });
}

export async function scheduledJobs(
  t: ServerTest,
  fn?: FunctionReference<"mutation" | "action", "public" | "internal">,
) {
  const name = fn && getFunctionName(fn);
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return name === undefined ? jobs : jobs.filter((job) => job.name === name);
}

const userTables = Object.keys(schema.tables) as TableNames[];

export function strictDatabaseGet<Database extends DatabaseReader>(
  db: Database,
): Database {
  const get: DatabaseReader["get"] = (
    ...args: [Id<TableNames>] | [TableNames, Id<TableNames>]
  ) => {
    const [table, id] = args.length === 1 ? [undefined, args[0]] : args;
    const tables = table ? [table] : userTables;
    if (!tables.some((name) => db.normalizeId(name, id)))
      throw new Error(`Invalid document ID: ${id}`);
    return table ? db.get(table, id) : db.get(id);
  };
  return { ...db, get };
}

export function countDatabaseReads<Database extends DatabaseReader>(
  db: Database,
) {
  const reads: string[] = [];
  const reader: DatabaseReader = {
    ...db,
    get: (...args: [Id<TableNames>] | [TableNames, Id<TableNames>]) => {
      reads.push("get");
      return args.length === 1 ? db.get(args[0]) : db.get(args[0], args[1]);
    },
    query: (table) => {
      reads.push(table);
      return db.query(table);
    },
  };
  return { db: { ...db, get: reader.get, query: reader.query }, reads };
}
