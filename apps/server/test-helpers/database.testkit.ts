import { convexTest } from "convex-test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import type {
  DatabaseReader,
  DatabaseWriter,
} from "../convex/_generated/server";
import schema from "../convex/schema";
import { allModules } from "../convex/testModules.testkit";

type TransactionLimits = Parameters<typeof convexTest>[0]["transactionLimits"];

export function serverTest(transactionLimits?: TransactionLimits) {
  return convexTest({ schema, modules: allModules, transactionLimits });
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

export function countDatabaseReads(db: DatabaseWriter): {
  db: DatabaseWriter;
  reads: string[];
};
export function countDatabaseReads(db: DatabaseReader): {
  db: DatabaseReader;
  reads: string[];
};
export function countDatabaseReads(db: DatabaseReader) {
  const reads: string[] = [];
  const reader: DatabaseReader = {
    ...db,
    get: (...args: [never, never?]) => {
      reads.push("get");
      return args.length === 1 ? db.get(args[0]) : db.get(args[0], args[1]!);
    },
    query: (table) => {
      reads.push(table);
      return db.query(table);
    },
  };
  return { db: reader, reads };
}
