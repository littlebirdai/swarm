// entity_subscriptions.via says who performed the enrolling act. Agents run
// under the owner's API token, so identity alone cannot tell a person's act
// from an agent's; every subscribeUser call site states it. These tests pin
// the stamp each call site sends and the upgrade rule in ensureSubscribed.
import { describe, expect, test } from "bun:test";
import { taskTest } from "../test-helpers/tasks.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const TOKEN = "via-test-token";

const setup = (...shortIds: string[]) =>
  taskTest(
    "subscription via",
    TOKEN,
    shortIds.map((short_id) => ({ short_id, source: "agent" })),
  );

async function stamp(
  setup: Awaited<ReturnType<typeof taskTest>>,
  reason: string,
  userId: Id<"users"> = setup.owner,
) {
  return (await setup.subscriptions())
    .filter((s) => s.reason === reason && s.user_id === userId)
    .map((s) => s.via);
}

describe("create: creator enrollment follows task origin", () => {
  test("a CLI create with no source is human origin, so the creator is human", async () => {
    const world = await setup();
    await world.t.mutation(api.tasks.create, { api_token: TOKEN, title: "t" });
    expect(await stamp(world, "creator")).toEqual(["human"]);
  });

  test("an agent-origin create enrolls its owner as an agent act", async () => {
    const world = await setup();
    await world.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "t",
      source: "agent",
      conversation_id: "sess-1",
    });
    expect(await stamp(world, "creator")).toEqual(["agent"]);
  });

  test("meeting origin and promotion both count as a person deciding", async () => {
    const a = await setup();
    await a.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "t",
      source: "meeting",
    });
    expect(await stamp(a, "creator")).toEqual(["human"]);
    const b = await setup();
    await b.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "t",
      source: "agent",
      promoted: true,
    });
    expect(await stamp(b, "creator")).toEqual(["human"]);
  });

  test("assignee at create carries the actor's kind, not the task origin", async () => {
    const world = await setup();
    await world.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "t",
      source: "agent",
      assignee: "bob",
      conversation_id: "sess-1",
    });
    expect(await stamp(world, "assignee", world.bob)).toEqual(["agent"]);
    const byHand = await setup();
    await byHand.t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "t",
      source: "agent",
      assignee: "bob",
    });
    expect(await stamp(byHand, "assignee", byHand.bob)).toEqual(["human"]);
  });
});

describe("CLI update, comment, batchAssign", () => {
  test("update assignee: a session call is agent, a terminal call is human", async () => {
    const a = await setup("ct-1");
    await a.t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      assignee: "bob",
      conversation_id: "sess-1",
    });
    expect(await stamp(a, "assignee", a.bob)).toEqual(["agent"]);
    const b = await setup("ct-1");
    await b.t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      assignee: "bob",
    });
    expect(await stamp(b, "assignee", b.bob)).toEqual(["human"]);
  });

  test("addComment: conversation_id marks the commenter as an agent act", async () => {
    const a = await setup("ct-1");
    await a.t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "x",
      conversation_id: "sess-1",
    });
    expect(await stamp(a, "commenter")).toEqual(["agent"]);
    const b = await setup("ct-1");
    await b.t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "x",
    });
    expect(await stamp(b, "commenter")).toEqual(["human"]);
  });

  test("batchAssign is a person at the terminal", async () => {
    const world = await setup("ct-1", "ct-2");
    await world.t.mutation(api.tasks.batchAssign, {
      api_token: TOKEN,
      short_ids: ["ct-1", "ct-2"],
      assignee: "bob",
    });
    expect(await stamp(world, "assignee", world.bob)).toEqual([
      "human",
      "human",
    ]);
  });
});

describe("web mutations are human acts", () => {
  test("webAddComment stamps human", async () => {
    const world = await setup("ct-1");
    await world.web.mutation(api.tasks.webAddComment, {
      short_id: "ct-1",
      text: "hi",
    });
    expect(await stamp(world, "commenter")).toEqual(["human"]);
  });

  test("webUpdate assignee stamps human for the assignee", async () => {
    const world = await setup("ct-1");
    await world.web.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      assignee: world.bob,
    });
    expect(await stamp(world, "assignee", world.bob)).toEqual(["human"]);
  });
});

describe("ensureSubscribed stores via and only ever upgrades", () => {
  async function provision() {
    const world = await setup("ct-1", "ct-2");
    const [first, second] = world.taskIds;
    const subscribe = (entity: Id<"tasks">, via?: "agent" | "human") =>
      world.t.mutation(internal.notificationRouter.ensureSubscribed, {
        user_id: world.owner,
        entity_type: "task",
        entity_id: entity,
        reason: "commenter",
        via,
      });
    return { ...world, first, second, subscribe };
  }

  test("a new row stores the stamp; a legacy write stores none", async () => {
    const { first, second, subscribe, subscriptions } = await provision();
    await subscribe(first, "agent");
    expect((await subscriptions())[0].via).toBe("agent");
    await subscribe(second);
    expect((await subscriptions())[1].via).toBeUndefined();
  });

  test("a human act upgrades an agent or legacy row; an agent act never downgrades", async () => {
    const { first, second, subscribe, subscriptions } = await provision();
    await subscribe(first, "agent");
    await subscribe(first, "human");
    expect((await subscriptions())[0].via).toBe("human");
    await subscribe(first, "agent");
    expect((await subscriptions())[0].via).toBe("human");
    expect(await subscriptions()).toHaveLength(1);

    await subscribe(second);
    await subscribe(second, "human");
    expect((await subscriptions())[1].via).toBe("human");
  });
});
