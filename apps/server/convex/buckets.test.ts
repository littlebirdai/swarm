import { describe, expect, test } from "bun:test";
import {
  matchBucketByName,
  requireExactLabel,
  resolveOrCreateBucket,
  assignConversationToBucketForUser,
  createBucketForUser,
  createBucketWithAssignmentsV2ForUser,
} from "./buckets";

import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "label catalog");
    const user = await rows.user();
    const peer = await rows.user();
    const conversation = await rows.conversation(user);
    const foreign = await rows.conversation(peer);
    const team = await rows.team();
    await rows.membership(user, team, { visibility: "full" });
    await rows.membership(peer, team, { visibility: "full" });
    const shared = await rows.conversation(peer, {
      team_id: team,
      is_private: false,
    });
    const privateSession = await rows.conversation(peer, {
      team_id: team,
      is_private: true,
    });
    return { user, conversation, foreign, shared, privateSession };
  });
  const web = asUser(t, ids.user);
  return {
    t,
    web,
    ...ids,
    resolve: (name: string) =>
      t.run((ctx) => resolveOrCreateBucket(ctx, ids.user, name)),
    seed: (name: string) =>
      t.run(({ db }) =>
        db.insert("inbox_buckets", {
          user_id: ids.user,
          name,
          created_at: 1,
          updated_at: 1,
        }),
      ),
    view: () => web.query(api.buckets.webListV2, {}),
    assignments: () =>
      t.run(({ db }) => db.query("bucket_assignments").collect()),
    labels: () => t.run(({ db }) => db.query("inbox_buckets").collect()),
  };
}

describe("resolveOrCreateBucket", () => {
  test("creates a label on first use, then reuses it (no duplicate)", async () => {
    const c = await setup();
    const first = await c.resolve("api");
    expect(first.created).toBe(true);
    expect(await c.labels()).toHaveLength(1);
    expect(await c.resolve("  API ")).toEqual({
      created: false,
      bucketId: first.bucketId,
      name: "api",
    });
    expect(await c.labels()).toHaveLength(1);
  });

  test("a near-name does NOT fuzzy-match — it creates a distinct label", async () => {
    const c = await setup();
    await c.resolve("apiv2");
    expect((await c.resolve("api")).created).toBe(true);
    expect(await c.labels()).toHaveLength(2);
  });

  test("new labels sort after existing ones (max sort_order + 1024)", async () => {
    const c = await setup();
    await c.t.run(async (ctx) => {
      await createBucketForUser(ctx, c.user, { name: "first" });
      await createBucketForUser(ctx, c.user, { name: "second" });
    });
    const [first, second] = await c.labels();
    expect(second.sort_order).toBe(first.sort_order! + 1024);
  });

  test("blank name is rejected", async () => {
    const c = await setup();
    await expect(c.resolve("   ")).rejects.toThrow(/required/i);
    expect(await c.labels()).toEqual([]);
  });
});

describe("assignConversationToBucketForUser", () => {
  test("inserts then upserts the single (user, conversation) row — never a second", async () => {
    const c = await setup();
    const first = await c.seed("First");
    const second = await c.seed("Second");
    for (const bucket of [first, second, null]) {
      await c.t.run((ctx) =>
        assignConversationToBucketForUser(ctx, c.user, c.conversation, bucket),
      );
      const assignments = await c.assignments();
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        user_id: c.user,
        conversation_id: c.conversation,
      });
      expect(assignments[0].bucket_id).toBe(bucket ?? undefined);
    }
  });
});
describe("rename and archive take the exact label only", () => {
  const buckets = [
    { _id: "b1", name: "apiv2" },
    { _id: "b2", name: "Frontend" },
    { _id: "b3", name: "old", archived_at: 1 },
  ];

  test("a substring of another label is refused, naming the labels there are", async () => {
    await expect(requireExactLabel(buckets, "api")).rejects.toThrow(
      /No label named "api". Your labels: Frontend, apiv2/,
    );
    await expect(requireExactLabel(buckets, "old")).rejects.toThrow(
      /No label named/,
    );
  });

  test("the exact name matches, whatever its case", async () => {
    expect((await requireExactLabel(buckets, " frontend "))._id).toBe("b2");
    expect((await requireExactLabel(buckets, "apiv2"))._id).toBe("b1");
  });
});

describe("matchBucketByName (existing helper, used by the read filters)", () => {
  const buckets = [
    { _id: "b1", name: "backend" },
    { _id: "b2", name: "frontend" },
  ] as any[];

  test("exact wins, substring falls back, miss lists the catalog", () => {
    expect((matchBucketByName(buckets, "backend") as any)._id).toBe("b1");
    expect((matchBucketByName(buckets, "front") as any)._id).toBe("b2");
    const miss = matchBucketByName(buckets, "zzz");
    expect("error" in miss && miss.error).toContain("backend, frontend");
  });
});

describe("buckets v2 complete view and command receipts", () => {
  test("auth unavailability is explicit and cannot masquerade as an empty catalog", async () => {
    const result = await serverTest().query(api.buckets.webListV2, {});
    expect(result).toEqual({
      contractId: "buckets.principal/v2",
      viewKey: "buckets:principal",
      access: "unauthenticated",
    });
    expect("buckets" in result).toBe(false);
  });

  test("an authenticated empty catalog is a granted complete view at revision zero", async () => {
    const c = await setup();
    expect(await c.view()).toMatchObject({
      access: "granted",
      viewRevision: 0,
      buckets: [],
      assignments: [],
    });
  });

  test("create is atomic with a revision receipt and exact replay is side-effect free", async () => {
    const c = await setup();
    const args = { command_id: "cmd-create", name: "Infra", color: "blue" };
    const first = await c.web.mutation(api.buckets.webCreateV2, args);
    expect(await c.web.mutation(api.buckets.webCreateV2, args)).toEqual(first);
    expect(await c.labels()).toHaveLength(1);
    expect(
      await c.t.run(({ db }) => db.query("local_command_receipts").collect()),
    ).toHaveLength(1);
    expect(first.coverage).toEqual([
      {
        contractId: "buckets.principal/v2",
        viewKey: "buckets:principal",
        revision: 1,
      },
      {
        kind: "command-id",
        contractId: "buckets.principal/v3",
        viewKey: "buckets:principal",
        commandId: "cmd-create",
      },
    ]);
    expect(await c.view()).toMatchObject({
      viewRevision: 1,
      buckets: [{ name: "Infra" }],
    });
  });

  test("update and assignment each cover the same complete atomic view", async () => {
    const c = await setup();
    const bucket_id = await c.seed("Before");
    const updated = await c.web.mutation(api.buckets.webUpdateV2, {
      command_id: "cmd-update",
      bucket_id,
      name: "After",
    });
    const assigned = await c.web.mutation(api.buckets.webAssignV2, {
      command_id: "cmd-assign",
      conversation_id: c.conversation,
      bucket_id,
    });
    expect(updated.coverage[0]).toMatchObject({ revision: 1 });
    expect(assigned.coverage[0]).toMatchObject({ revision: 2 });
    expect(await c.assignments()).toHaveLength(1);
    expect((await c.labels())[0].name).toBe("After");
  });

  test("files a teammate's team-visible session — labels are personal filing", async () => {
    const c = await setup();
    const create = (
      commandId: string,
      name: string,
      conversationIds: (typeof c.conversation)[],
    ) =>
      c.t.run((ctx) =>
        createBucketWithAssignmentsV2ForUser(ctx, c.user, {
          commandId,
          name,
          conversationIds,
        }),
      );
    const created = await create("cmd-create-shared", "Bots", [c.shared]);
    expect(created.status).toBe("acknowledged");
    if (created.status !== "acknowledged")
      throw new Error("Missing label receipt");
    const [label] = await c.labels();
    expect(created.result).toMatchObject({ bucketId: label._id });
    const bucket_id = label._id;
    expect((await c.assignments()).map((a) => a.conversation_id)).toEqual([
      c.shared,
    ]);
    const assigned = await c.web.mutation(api.buckets.webAssignV2, {
      command_id: "cmd-assign-shared",
      conversation_id: c.shared,
      bucket_id,
    });
    expect(assigned.status).toBe("acknowledged");
    expect(
      await create("cmd-create-private", "Nope", [c.privateSession]),
    ).toMatchObject({
      status: "rejected",
      rejection: { code: "FORBIDDEN" },
    });
    const refused = await c.web.mutation(api.buckets.webAssignV2, {
      command_id: "cmd-assign-private",
      conversation_id: c.privateSession,
      bucket_id,
    });
    expect(refused.status).toBe("rejected");
  });

  test("foreign relationship rejection is durable and does not move view coverage", async () => {
    const c = await setup();
    const args = { command_id: "cmd-foreign", conversation_id: c.foreign };
    const first = await c.web.mutation(api.buckets.webAssignV2, args);
    expect(first).toMatchObject({
      status: "rejected",
      rejection: { code: "NOT_FOUND" },
    });
    expect(await c.web.mutation(api.buckets.webAssignV2, args)).toEqual(first);
    expect(await c.assignments()).toEqual([]);
    expect(
      await c.t.run(({ db }) => db.query("local_view_heads").collect()),
    ).toEqual([]);
  });
});
