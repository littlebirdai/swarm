import { describe, expect, test } from "bun:test";
import {
  countDatabaseReads,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { resolveSpawnParentId } from "./conversations";

describe("resolveSpawnParentId", () => {
  test("stored parent wins without a lookup", async () => {
    await serverTest().run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "stored spawn parent");
      const user = await rows.user();
      const stored = await rows.conversation(user);
      const other = await rows.conversation(user);
      await rows.message(other, { message_uuid: "spawn-message" });
      const { db, reads } = countDatabaseReads(ctx.db);
      expect(
        await resolveSpawnParentId(
          { db },
          {
            parent_conversation_id: stored,
            parent_message_uuid: "spawn-message",
          },
        ),
      ).toBe(stored);
      expect(reads).toEqual([]);
    });
  });

  test("a subagent that only knows its spawning message resolves through it", async () => {
    await serverTest().run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "spawn message");
      const user = await rows.user();
      const other = await rows.conversation(user);
      const spawner = await rows.conversation(user);
      await rows.message(other);
      await rows.message(spawner, { message_uuid: "spawn-message" });
      const { db, reads } = countDatabaseReads(ctx.db);
      expect(
        await resolveSpawnParentId(
          { db },
          { parent_message_uuid: "spawn-message" },
        ),
      ).toBe(spawner);
      expect(reads).toEqual(["messages"]);
    });
  });

  test("a fork is not a spawned session: its fork point never resolves to a parent", async () => {
    await serverTest().run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "fork point");
      const origin = await rows.conversation(await rows.user());
      await rows.message(origin, { message_uuid: "fork-point" });
      const { db, reads } = countDatabaseReads(ctx.db);
      expect(
        await resolveSpawnParentId(
          { db },
          {
            parent_message_uuid: "fork-point",
            forked_from: origin,
          },
        ),
      ).toBeNull();
      expect(reads).toEqual([]);
    });
  });

  test("nothing to go on resolves to null", async () => {
    await serverTest().run(async (ctx) => {
      expect(await resolveSpawnParentId(ctx, {})).toBeNull();
    });
  });
});
