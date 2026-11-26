import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  asUser,
  serverTest,
  type ServerTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { getFunctionName, type FunctionReference } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashToken } from "./apiTokens";
import type { ActionCtx } from "./_generated/server";
import { cliRead, redactionValues } from "./secrets";

const at = 1_790_000_000_000;
const token = "a".repeat(64);
const name = "redaction-key";
const original = "original-value-12345";
const replacement = "replacement-value-12345";
const keyEnv = "CONNECTION_SECRETS_KEY";
let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env[keyEnv];
  process.env[keyEnv] = "test-deployment-key-0123456789abcdef";
  setSystemTime(new Date(at));
});

afterEach(() => {
  setSystemTime();
  if (previousKey === undefined) delete process.env[keyEnv];
  else process.env[keyEnv] = previousKey;
});

async function seed() {
  const t = serverTest();
  const owner = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "redaction audit");
    const user = await rows.user();
    await db.insert("api_tokens", {
      user_id: user,
      token_hash: await hashToken(token),
      name: "CLI",
      created_at: at,
      last_used_at: at,
    });
    return user;
  });
  const viewer = asUser(t, owner);
  const made = await viewer.action(api.secrets.create, {
    name,
    kind: "key",
    personal: true,
    payload: { value: original },
  });
  if ("error" in made) throw new Error(made.error);
  const id = made.id as Id<"secrets">;
  const feed = () =>
    t.action(api.secrets.redactionValues, { api_token: token });
  const rotate = async (value = replacement) => {
    const result = await viewer.action(api.secrets.rotate, {
      ref: name,
      payload: { value },
    });
    if (!("value_updated_at" in result))
      throw new Error("Expected the rotated value version");
    return result.value_updated_at;
  };
  const askFirst = () =>
    viewer.mutation(api.secrets.setAskFirst, { ref: name, ask_first: true });
  const events = () =>
    t.run(async ({ db }) => {
      return db
        .query("secret_events")
        .withIndex("by_secret_at", (q) => q.eq("secret_id", id))
        .collect();
    });
  const receipts = async () =>
    (await events()).filter((event) => event.kind === "redaction_sync");
  return {
    t,
    owner,
    id,
    shortId: made.short_id,
    firstVersion: made.value_updated_at,
    feed,
    rotate,
    askFirst,
    events,
    remove: () => viewer.mutation(api.secrets.remove, { ref: name }),
    receipts,
  };
}

async function interleaveBeforeMutation<T>(
  t: ServerTest,
  target: FunctionReference<"mutation", "internal">,
  interleave: () => Promise<void>,
  run: (ctx: ActionCtx) => Promise<T>,
): Promise<T> {
  const targetName = getFunctionName(target);
  let intercepted = false;
  const result = await t.action((ctx) =>
    run({
      ...ctx,
      runMutation: async (ref, ...args) => {
        if (!intercepted && getFunctionName(ref) === targetName) {
          intercepted = true;
          await interleave();
        }
        return ctx.runMutation(ref, ...args);
      },
    }),
  );
  expect(intercepted).toBe(true);
  return result;
}

test("a CLI read audits its snapshot even if the secret rotates before the audit", async () => {
  const { t, events, firstVersion, rotate, askFirst, feed } = await seed();
  const read = await interleaveBeforeMutation(
    t,
    internal.secrets.recordReads,
    async () => {
      setSystemTime(new Date(at + 1_000));
      await rotate();
    },
    (ctx) =>
      cliRead._handler(ctx, {
        api_token: token,
        refs: [name],
        purpose: "get",
      }),
  );
  expect(read).toMatchObject({
    secrets: [{ value_updated_at: firstVersion, payload: { value: original } }],
  });
  await askFirst();
  expect(await feed()).toMatchObject({ values: [{ name, value: original }] });
  expect(
    (await events())
      .filter((event) => event.kind === "read")
      .map((event) => event.value_version),
  ).toEqual([firstVersion]);
});

test("a feed audits its snapshot when the secret is deleted before the receipt", async () => {
  const { t, owner, id, shortId, remove, receipts, firstVersion } =
    await seed();
  const response = await interleaveBeforeMutation(
    t,
    internal.secrets.recordRedactionSync,
    async () => {
      expect(await remove()).toMatchObject({ removed: true });
    },
    (ctx) => redactionValues._handler(ctx, { api_token: token }),
  );
  expect(response).toMatchObject({ values: [{ name, value: original }] });
  expect(await t.run(({ db }) => db.get(id))).toBeNull();
  expect(await receipts()).toEqual([
    expect.objectContaining({
      actor_user_id: owner,
      workspace: `user:${owner}`,
      secret_short_id: shortId,
      secret_name: name,
      value_version: firstVersion,
    }),
  ]);
});

test("opening a kept value does not audit an unreadable current value", async () => {
  const { t, id, feed, rotate, receipts, firstVersion } = await seed();
  await feed();
  await rotate();
  await t.run(async ({ db }) => {
    const current = await db.get(id);
    if (!current?.value_id) throw new Error("Expected the current ciphertext");
    await db.delete(current.value_id);
  });
  expect(await feed()).toMatchObject({ values: [{ name, value: original }] });
  expect((await receipts()).map((event) => event.value_version)).toEqual([
    firstVersion,
  ]);
});

test("concurrent feeds audit a value once if it rotates before the receipt is written", async () => {
  const { feed, rotate, receipts, firstVersion } = await seed();
  const snapshots = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let remaining = 2;
  const pause = spyOn(crypto.subtle, "decrypt").mockImplementation(
    async (...args) => {
      if (remaining > 0) {
        if (--remaining === 0) snapshots.resolve();
        await resume.promise;
      }
      return decrypt(...args);
    },
  );
  const reads = [feed(), feed()];
  const both = Promise.all(reads);
  try {
    await Promise.race([
      snapshots.promise,
      both.then(() => {
        throw new Error("The feeds finished before loading both snapshots");
      }),
    ]);
    setSystemTime(new Date(at + 1_000));
    const secondVersion = await rotate();
    resume.resolve();
    for (const receipt of await both)
      expect(receipt).toMatchObject({ values: [{ name, value: original }] });
    expect((await receipts()).map((row) => row.value_version)).toEqual([
      firstVersion,
    ]);

    expect(await feed()).toMatchObject({
      values: [
        { name, value: replacement },
        { name, value: original },
      ],
    });
    expect((await receipts()).map((row) => row.value_version)).toEqual([
      firstVersion,
      secondVersion,
    ]);
  } finally {
    resume.resolve();
    await Promise.allSettled(reads);
    pause.mockRestore();
  }
});

for (const legacyVersion of [false, true]) {
  test(`a legacy audit receipt covers the current value and its kept copy (legacy copy=${legacyVersion})`, async () => {
    const { t, id, owner, feed, rotate, askFirst, receipts } = await seed();
    await t.run(async ({ db }) => {
      const secret = await db.get(id);
      if (!secret) throw new Error("Expected a secret");
      await db.insert("secret_events", {
        secret_id: id,
        workspace: secret.workspace,
        secret_name: name,
        kind: "redaction_sync",
        actor_user_id: owner,
        at: at + 1,
      });
    });
    await askFirst();
    setSystemTime(new Date(at + 1_000));
    expect(await feed()).toMatchObject({ values: [{ name, value: original }] });
    expect((await receipts()).map((row) => row.value_version)).toEqual([
      undefined,
    ]);

    await rotate();
    if (legacyVersion) {
      await t.run(async ({ db }) => {
        const kept = await db
          .query("secret_versions")
          .withIndex("by_secret", (q) => q.eq("secret_id", id))
          .unique();
        if (!kept) throw new Error("Expected a kept version");
        await db.patch(kept._id, { value_version: undefined });
      });
    }
    expect(await feed()).toMatchObject({ values: [{ name, value: original }] });
    expect((await receipts()).map((row) => row.value_version)).toEqual([
      undefined,
    ]);
  });
}

test("a kept version ahead of its wall-clock cutoff skips the inverted legacy range", async () => {
  const { feed, rotate, askFirst } = await seed();
  await feed();
  await askFirst();
  await rotate();
  await rotate("third-value-12345");
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const originalSyscall = Object.getOwnPropertyDescriptor(runtime, "syscall")!;
  const inverted: string[] = [];
  Object.defineProperty(runtime, "syscall", {
    ...originalSyscall,
    get() {
      const syscall = originalSyscall.get!.call(runtime);
      return (operation: string, json: string) => {
        if (operation === "1.0/queryStream") {
          const { source } = JSON.parse(json).query;
          if (source.indexName?.startsWith("secret_events.")) {
            const range = source.range as {
              fieldPath: string;
              type: string;
              value: number;
            }[];
            const lower = range.find(
              (edge) => edge.fieldPath === "at" && edge.type === "Gte",
            )?.value;
            const upper = range.find(
              (edge) => edge.fieldPath === "at" && edge.type === "Lte",
            )?.value;
            if (lower !== undefined && upper !== undefined && lower > upper)
              inverted.push(source.indexName);
          }
        }
        return syscall(operation, json);
      };
    },
  });
  try {
    expect(await feed()).toMatchObject({ values: [{ name, value: original }] });
    expect(inverted).toEqual([]);
  } finally {
    Object.defineProperty(runtime, "syscall", originalSyscall);
  }
});
