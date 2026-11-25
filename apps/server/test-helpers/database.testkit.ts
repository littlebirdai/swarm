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

export function serverTest(transactionLimits?: TransactionLimits) {
  return convexTest({
    schema: testSchema,
    modules: allModules,
    transactionLimits,
  });
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
