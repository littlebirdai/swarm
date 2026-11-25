import { describe, expect, spyOn, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { submitComments } from "./artifacts";
import type { FunctionArgs } from "convex/server";
import type { MutationCtx } from "./_generated/server";

describe("bucket receipt dispatches tolerate client stub ids", () => {
  async function setup() {
    const t = serverTest();
    const { user, conversation, bucket } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "label dispatch");
      const user = await rows.user();
      const conversation = await rows.conversation(user);
      const bucket = await db.insert("inbox_buckets", {
        user_id: user,
        name: "api",
        created_at: 1,
        updated_at: 1,
      });
      return { user, conversation, bucket };
    });
    const actor = asUser(t, user);
    return {
      conversation,
      bucket,
      dispatch: (action: string, args: unknown[], commandId: string) =>
        actor.mutation(api.dispatch.dispatch, {
          action,
          args,
          result: { receiptActionVersion: 1, commandId },
        }),
      assignments: () =>
        t.run(({ db }) => db.query("bucket_assignments").collect()),
      receipts: () =>
        t.run(({ db }) => db.query("local_command_receipts").collect()),
      labels: () => t.run(({ db }) => db.query("inbox_buckets").collect()),
    };
  }

  test("assign with a stub conversation id (fork inheritance) acknowledges as a durable no-op", async () => {
    const c = await setup();
    const input = ["p2juk3l0abcm9xylocalforkstub", c.bucket];
    const first = await c.dispatch(
      "assignSessionToBucket",
      input,
      "assign-stub-conv",
    );
    expect(first).toMatchObject({
      commandId: "assign-stub-conv",
      status: "acknowledged",
      result: { gate: "conv_not_found" },
    });
    expect(
      await c.dispatch("assignSessionToBucket", input, "assign-stub-conv"),
    ).toEqual(first);
    expect(await c.assignments()).toEqual([]);
    expect(await c.receipts()).toHaveLength(1);
  });

  test("assign to a still-optimistic label stub acknowledges as a no-op", async () => {
    const c = await setup();
    const receipt = await c.dispatch(
      "assignSessionToBucket",
      [c.conversation, "localbucketstub123"],
      "assign-stub-bucket",
    );
    expect(receipt).toMatchObject({
      status: "acknowledged",
      result: { gate: "bucket_not_owned" },
    });
    expect(await c.assignments()).toEqual([]);
  });

  test("assign with real ids stores the label assignment and receipt", async () => {
    const c = await setup();
    const receipt = await c.dispatch(
      "assignSessionToBucket",
      [c.conversation, c.bucket],
      "assign-real",
    );
    expect(receipt).toMatchObject({
      commandId: "assign-real",
      status: "acknowledged",
      result: { conversationId: c.conversation, bucketId: c.bucket },
    });
    const assignments = await c.assignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      conversation_id: c.conversation,
      bucket_id: c.bucket,
    });
    expect(await c.receipts()).toHaveLength(1);
  });

  test("updateBucket against a label stub returns a rejected receipt instead of throwing", async () => {
    const c = await setup();
    const before = await c.labels();
    const receipt = await c.dispatch(
      "updateBucket",
      ["localbucketstub123", { name: "renamed" }],
      "update-stub-bucket",
    );
    expect(receipt).toMatchObject({
      commandId: "update-stub-bucket",
      status: "rejected",
      rejection: { code: "NOT_FOUND" },
    });
    expect(await c.labels()).toEqual(before);
  });
});

describe("thread read side effects: both arg shapes", () => {
  async function setup() {
    const t = serverTest();
    const ids = await t.run(async ({ db, storage }) => {
      const rows = fixtureRows(db, "thread dispatch");
      const user = await rows.user();
      const team = await rows.team();
      await rows.membership(user, team);
      const channel = await db.insert("chat_channels", {
        team_id: team,
        name: "General",
        kind: "public",
        created_by: user,
        created_at: 1,
        updated_at: 1,
      });
      const chat = "m".repeat(32);
      const conversation = await rows.conversation(user);
      const message = await rows.message(conversation);
      const comment = `${conversation}:msg:${message}`;
      const task = await rows.task(user);
      const page = await rows.artifact(
        user,
        await storage.store(new Blob(["report"])),
        { slug: "report", session_conversation_id: conversation },
      );
      const thread = (
        kind: NewRow<"thread_reads">["kind"],
        root_key: string,
        fields: Partial<NewRow<"thread_reads">>,
      ) =>
        db.insert("thread_reads", {
          user_id: user,
          kind,
          root_key,
          last_activity_at: 10,
          last_read_at: 0,
          updated_at: 1,
          ...fields,
        });
      await thread("chat", chat, { channel_id: channel, team_id: team });
      await thread("comment", comment, {
        conversation_id: conversation,
        message_id: message,
        team_id: team,
      });
      await thread("task", task, { task_id: task });
      await thread("page", page, { artifact_id: page });
      return { user, team, chat, comment, task, page };
    });
    const actor = asUser(t, ids.user);
    return {
      ...ids,
      run: (action: string, args: unknown[]) =>
        actor.mutation(api.dispatch.dispatch, { action, args }),
      unread: (kind: NewRow<"thread_reads">["kind"]) =>
        t.run(async ({ db }) => {
          const rows = await db.query("thread_reads").collect();
          for (const row of rows.filter((r) => r.kind === kind))
            await db.patch(row._id, { last_read_at: 0 });
        }),
      marks: () =>
        t.run(async ({ db }) =>
          (await db.query("thread_reads").collect())
            .filter((r) => r.last_read_at > 0)
            .map((r) => r.kind),
        ),
      comments: () =>
        t.run(({ db }) => db.query("artifact_comments").collect()),
    };
  }

  test("legacy [rootId] shape marks a chat thread", async () => {
    const c = await setup();
    await c.run("markThreadRead", [c.chat]);
    expect(await c.marks()).toEqual(["chat"]);
  });

  test("new [kind, rootKey] shape forwards the kind", async () => {
    const c = await setup();
    await c.run("markThreadRead", ["task", c.task]);
    expect(await c.marks()).toEqual(["task"]);
  });

  test("a comment key keeps its colons; only its conversation half is id-checked", async () => {
    const c = await setup();
    await c.run("markThreadRead", ["comment", c.comment]);
    expect(await c.marks()).toEqual(["comment"]);
  });

  test("stub ids and unknown kinds are dropped, not forwarded", async () => {
    const c = await setup();
    const invalid = [
      ["local-stub-id"],
      ["comment", "convstub:msg:abc"],
      ["channel", c.chat],
    ];
    for (const args of invalid)
      expect(await c.run("markThreadRead", args)).toBeNull();
    expect(await c.marks()).toEqual([]);
  });

  test("markAllThreadsRead with no args sweeps the personal inbox", async () => {
    const c = await setup();
    expect(await c.run("markAllThreadsRead", [])).toEqual({ marked: 2 });
    expect(await c.marks()).toEqual(["task", "page"]);
  });

  test("markAllThreadsRead forwards a valid team and kind, drops invalid ones", async () => {
    const c = await setup();
    expect(await c.run("markAllThreadsRead", [c.team, "comment"])).toEqual({
      marked: 1,
    });
    expect(await c.marks()).toEqual(["comment"]);
    expect(await c.run("markAllThreadsRead", ["team-stub", "channel"])).toEqual(
      { marked: 2 },
    );
    expect(await c.marks()).toEqual(["comment", "task", "page"]);
  });

  test('a legacy one-argument call is the chat sweep; "all" is the explicit unscoped one', async () => {
    const c = await setup();
    await c.run("markAllThreadsRead", [c.team]);
    expect(await c.marks()).toEqual(["chat"]);
    await c.run("markAllThreadsRead", [c.team, "all"]);
    expect(await c.marks()).toEqual(["chat", "comment", "page"]);
    await c.unread("page");
    await c.run("markAllThreadsRead", [null, "page"]);
    expect(await c.marks()).toEqual(["chat", "comment", "page"]);
  });

  test("markThreadRead forwards the page kind", async () => {
    const c = await setup();
    await c.run("markThreadRead", ["page", c.page]);
    expect(await c.run("markThreadRead", ["page", "pagestub-1"])).toBeNull();
    expect(await c.marks()).toEqual(["page"]);
  });

  test("addPageComment forwards slug or artifact id with the client_id; stubs are dropped", async () => {
    const c = await setup();
    await c.run("addPageComment", [
      { slug: "report", text: "hi", clientId: "cl-1" },
    ]);
    const [parent] = await c.comments();
    const parentKey = "b".repeat(32);
    const handler = submitComments as typeof submitComments & {
      _handler: (
        ctx: MutationCtx,
        args: FunctionArgs<typeof api.artifacts.submitComments>,
      ) => Promise<unknown>;
    };
    const submit = handler._handler;
    const forwarded = spyOn(handler, "_handler").mockImplementation(
      (ctx, args) =>
        submit(ctx, {
          ...args,
          parent_id: args.parent_id === parentKey ? parent._id : args.parent_id,
        }),
    );
    try {
      await c.run("addPageComment", [
        {
          artifactId: c.page,
          text: "yo",
          parentId: parentKey,
          clientId: "cl-2",
        },
      ]);
      expect(forwarded.mock.calls.map(([, args]) => args)).toEqual([
        {
          artifact_id: c.page,
          author_name: "",
          deliver: false,
          from_app: true,
          parent_id: parentKey,
          client_id: "cl-2",
          comments: [{ text: "yo" }],
        },
      ]);
    } finally {
      forwarded.mockRestore();
    }
    expect(
      await c.run("addPageComment", [
        { artifactId: "pagestub-1", text: "nope", clientId: "cl-3" },
      ]),
    ).toBeNull();
    const comments = await c.comments();
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      artifact_id: c.page,
      text: "hi",
      client_id: "cl-1",
      author_user_id: c.user,
      delivered: false,
    });
    expect(comments[1]).toMatchObject({
      artifact_id: c.page,
      text: "yo",
      client_id: "cl-2",
      author_user_id: c.user,
      delivered: false,
      parent_comment_id: parent._id,
    });
  });
});
