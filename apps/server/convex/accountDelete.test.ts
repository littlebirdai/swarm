import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { makeFakeDb } from "./testDb";
import { purgeAccountPass } from "./accountDelete";

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";

describe("purgeAccountPass", () => {
  test("clears either takeover identity while keeping the machine fence intact", async () => {
    const t = serverTest();
    const { deleted, remaining, ids, fence } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "takeover account deletion");
      const deleted = await rows.user();
      const remaining = await rows.user();
      const conversation_id = await rows.conversation(remaining);
      const fence = {
        id: "fence",
        run: 1,
        turn: "turn",
        start_event_seq: 2,
        baton_token: null,
        new_baton_token: 1,
        state: "pending" as const,
        handed_out: true,
      };
      const insert = (takeover: {
        owner: typeof deleted;
        previous_holder: typeof deleted;
      }) =>
        db.insert("claims", {
          kind: "steer",
          conversation_id,
          token: 0,
          lease_until: 0,
          takeover: { ...fence, ...takeover },
        });
      return {
        deleted,
        remaining,
        fence,
        ids: [
          await insert({ owner: deleted, previous_holder: remaining }),
          await insert({ owner: remaining, previous_holder: deleted }),
        ],
      };
    });
    expect(await t.run((ctx) => purgeAccountPass(ctx, deleted))).toBe(false);
    expect(
      await t.run(async ({ db }) =>
        (await Promise.all(ids.map((id) => db.get(id)))).map(
          (claim) => claim?.takeover,
        ),
      ),
    ).toEqual([
      { ...fence, previous_holder: remaining },
      { ...fence, owner: remaining },
    ]);
  });

  test("an account too big for one pass is deleted over several, access first and the user row last", async () => {
    const conversations = Array.from({ length: 250 }, (_, i) => ({
      _id: `conv${i}`,
      user_id: ME,
    }));
    const db = makeFakeDb({
      users: [
        { _id: ME, email: "me@x.org" },
        { _id: MATE, email: "mate@x.org" },
      ],
      authSessions: [{ _id: "as1", userId: ME }],
      authAccounts: [{ _id: "aa1", userId: ME }],
      api_tokens: [
        { _id: "tok1", user_id: ME },
        { _id: "tok2", user_id: MATE },
      ],
      conversations: [...conversations, { _id: "mateconv", user_id: MATE }],
      notifications: [{ _id: "n1", recipient_user_id: ME }],
      team_memberships: [{ _id: "tm1", user_id: ME }],
      // My side answers on a teammate's session go with my account; theirs stay.
      side_answers: [
        { _id: "sa1", user_id: ME, conversation_id: "mateconv" },
        { _id: "sa2", user_id: MATE, conversation_id: "mateconv" },
      ],
    });
    const purged: string[] = [];
    const ctx: any = {
      db,
      scheduler: {
        runAfter: async (_ms: number, _fn: any, a: any) => {
          if (a.conversation_id) purged.push(a.conversation_id);
        },
      },
    };
    const rows = (t: string) => (db as any)._tables[t] ?? [];

    expect(await purgeAccountPass(ctx, ME as any)).toBe(true);
    expect(rows("authSessions")).toEqual([]);
    expect(rows("api_tokens").map((r: any) => r._id)).toEqual(["tok2"]);
    expect(rows("users").length).toBe(2);

    let passes = 1;
    while (
      await purgeAccountPass(ctx, ME as any).then((more) => (passes++, more))
    );
    expect(passes).toBe(3);
    expect(purged.length).toBe(250);
    expect(rows("conversations").map((r: any) => r._id)).toEqual(["mateconv"]);
    expect(rows("notifications")).toEqual([]);
    expect(rows("team_memberships")).toEqual([]);
    expect(rows("side_answers").map((r: any) => r._id)).toEqual(["sa2"]);
    expect(rows("authAccounts")).toEqual([]);
    expect(rows("users").map((r: any) => r._id)).toEqual([MATE]);
  });
});
