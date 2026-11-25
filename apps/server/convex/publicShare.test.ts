import { describe, expect, test } from "bun:test";
import { CALL_LINK_REFUSED_WORDS } from "@codecast/calls/callRecordings";
import { channelRoomKey } from "@codecast/calls/callRoomKeys";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { claimShareToken, writeObjectShareLink } from "./publicShare";
import { clampAudioRange, SHARED_CALL_AUDIO_PATH } from "./lib/sharedCallMedia";

const UUID_A = "1a221088-1fc3-48c8-a814-71119676adf0";
const UUID_B = "4c7c324f-3077-486a-a63c-65f188d18a0c";

async function tasks(...tokens: (string | undefined)[]) {
  const t = serverTest();
  const { user, ids } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task share links");
    const user = await rows.user();
    const ids = [];
    for (const share_token of tokens)
      ids.push(await rows.task(user, { share_token }));
    return { user, ids };
  });
  return {
    t,
    user,
    ids,
    claim: (id: Id<"tasks">, token: string | null) =>
      t.run(async (ctx) =>
        claimShareToken(ctx, "tasks", (await ctx.db.get(id))!, token, user),
      ),
    read: (id: Id<"tasks">) => t.run(({ db }) => db.get(id)),
    audit: () => t.run(({ db }) => db.query("authority_events").collect()),
  };
}

describe("claimShareToken", () => {
  test("turns the link on with a well-formed token and off with null", async () => {
    const c = await tasks(undefined);
    const [id] = c.ids;
    await c.claim(id, UUID_A);
    expect((await c.read(id))?.share_token).toBe(UUID_A);
    await c.claim(id, null);
    expect((await c.read(id))?.share_token).toBeUndefined();
    expect(
      (await c.audit()).map((event) => [event.kind, event.actor_user_id]),
    ).toEqual([
      ["share_link_minted", c.user],
      ["share_link_revoked", c.user],
    ]);
  });

  test("refuses a token another row already serves, so a link cannot be re-aimed", async () => {
    const c = await tasks(UUID_A, undefined);
    const before = await Promise.all(c.ids.map(c.read));
    await expect(c.claim(c.ids[1], UUID_A)).rejects.toThrow(
      /Invalid share token/,
    );
    expect(await Promise.all(c.ids.map(c.read))).toEqual(before);
    expect(await c.audit()).toEqual([]);
  });

  test("refuses a guessable token and keeps an existing one without writing", async () => {
    const c = await tasks(UUID_B);
    const [id] = c.ids;
    const before = await c.read(id);
    await expect(c.claim(id, "abc123")).rejects.toThrow(/Invalid share token/);
    const writes = await c.t.mutation(async (ctx) => {
      await claimShareToken(
        ctx,
        "tasks",
        (await ctx.db.get(id))!,
        UUID_B,
        c.user,
      );
      return (await ctx.meta.getTransactionMetrics()).documentsWritten.used;
    });
    expect(writes).toBe(0);
    expect(await c.read(id)).toEqual(before);
    expect(await c.audit()).toEqual([]);
  });
});

describe("writeObjectShareLink", () => {
  test("an unknown kind or a missing row writes nothing", async () => {
    const c = await tasks();
    for (const [kind, error] of [
      ["spaceship", /Unknown share kind/],
      ["task", /Not found/],
    ] as const) {
      await expect(
        c.t.run((ctx) =>
          writeObjectShareLink(ctx, c.user, kind, "missing", UUID_A),
        ),
      ).rejects.toThrow(error);
    }
    expect(await c.t.run(({ db }) => db.query("tasks").collect())).toEqual([]);
    expect(await c.audit()).toEqual([]);
  });
});

// A call's link opens by the people who sat through it (or a team admin) and
// closes by any reader: a channel huddle is readable by the whole channel,
// and somebody who was never in the room must not put its words, guests'
// included, on the open web (lib/callRecordingRuns.mayPublishCall).
describe("a call's public link", () => {
  async function channelCall() {
    const t = serverTest();
    const now = Date.now();
    const ids = await t.run(async (ctx: any) => {
      const team = await ctx.db.insert("teams", {
        name: "T",
        created_at: now,
        invite_code: "x",
        features: { calls: true, chat: true },
      });
      const [ana, ben, ada] = await Promise.all(
        ["Ana", "Ben", "Ada"].map((name) => ctx.db.insert("users", { name })),
      );
      for (const [u, role] of [
        [ana, "member"],
        [ben, "member"],
        [ada, "admin"],
      ] as const) {
        await ctx.db.insert("team_memberships", {
          user_id: u,
          team_id: team,
          role,
          joined_at: now,
        });
      }
      const channel = await ctx.db.insert("chat_channels", {
        team_id: team,
        name: "design",
        kind: "public",
        created_by: ana,
        created_at: now,
        updated_at: now,
      });
      const call = await ctx.db.insert("transcripts", {
        room_key: channelRoomKey(String(channel)),
        team_id: team,
        started_by: ana,
        status: "ended",
        started_at: now,
        ended_at: now + 60_000,
        participants: [
          { id: String(ana), name: "Ana" },
          { id: "guest:g1", name: "Dana (guest)" },
        ],
        routes: [],
        last_seq: 0,
      });
      return { team, ana, ben, ada, call };
    });
    const share = (who: string, token: string | null) =>
      t.run(async (ctx: any) =>
        writeObjectShareLink(ctx, who as any, "call", String(ids.call), token),
      );
    const token = () =>
      t.run(
        async (ctx: any) => (await ctx.db.get(ids.call))?.share_token ?? null,
      );
    return { t, ...ids, share, token };
  }

  test("a channel member who was not in the call may not open it, and may close it", async () => {
    const c = await channelCall();
    await expect(c.share(String(c.ben), UUID_A)).rejects.toThrow(
      CALL_LINK_REFUSED_WORDS,
    );
    expect(await c.token()).toBeNull();
    await c.share(String(c.ana), UUID_A);
    expect(await c.token()).toBe(UUID_A);
    // Keeping the link it already has is not opening it.
    await c.share(String(c.ben), UUID_A);
    await c.share(String(c.ben), null);
    expect(await c.token()).toBeNull();
  });

  test("turning it on or off is a line in the room's thread, once per change, naming who", async () => {
    const c = await channelCall();
    const lines = () =>
      c.t.run(async (ctx: any) =>
        (await ctx.db.query("call_chat_messages").collect()).map((r: any) => [
          r.event,
          String(r.user_id),
          String(r.transcript_id),
        ]),
      );
    await c.share(String(c.ana), UUID_A);
    // Keeping the link it already has changes nothing, and says nothing.
    await c.share(String(c.ana), UUID_A);
    await c.share(String(c.ben), null);
    await c.share(String(c.ben), null);
    expect(await lines()).toEqual([
      ["link_on", String(c.ana), String(c.call)],
      ["link_off", String(c.ben), String(c.call)],
    ]);
  });

  test("a speaker and a team admin may open it", async () => {
    const c = await channelCall();
    await c.share(String(c.ana), UUID_A);
    expect(await c.token()).toBe(UUID_A);
    await c.share(String(c.ana), null);
    await c.share(String(c.ada), UUID_B);
    expect(await c.token()).toBe(UUID_B);
  });
});

async function linkedCall(kind: "words" | "deleted-team" | "audio") {
  const t = serverTest();
  const ids = await t.run(async ({ db, storage }) => {
    const rows = fixtureRows(db, "public call");
    const user = await rows.user({ name: "Ada Lovelace" });
    const team = await rows.team({
      deleted_at: kind === "deleted-team" ? 5 : undefined,
    });
    const audio =
      kind === "audio" ? await storage.store(new Blob(["audio"])) : undefined;
    const roomKey = kind === "audio" ? "rec:abc" : `team:${team}`;
    const call = await db.insert("transcripts", {
      team_id: team,
      started_by: user,
      room_key: roomKey,
      share_token: UUID_A,
      status: "ended",
      started_at: 1,
      ended_at: 2,
      title: "Standup",
      participants:
        kind === "words" ? [{ id: user, name: "Ada Lovelace" }] : [],
      summary: "Talked.",
      action_items: ["Ship"],
      routes: [],
      last_seq: kind === "words" ? 1 : 0,
      recording_storage_id: audio,
    });
    if (kind === "words")
      await db.insert("transcript_segments", {
        transcript_id: call,
        seq: 1,
        speaker_id: user,
        speaker_name: "Ada Lovelace",
        text: "hi",
        t0: 0,
        t1: 5,
      });
    return { call, team, user, roomKey, audio };
  });
  return {
    t,
    ...ids,
    read: () => t.query(api.publicShare.getSharedCall, { share_token: UUID_A }),
    audioSource: () =>
      t.query(internal.publicShare.sharedCallAudioSource, {
        share_token: UUID_A,
      }),
  };
}

describe("getSharedCall", () => {
  test("a stranger reads names and words but never a user id", async () => {
    const c = await linkedCall("words");
    const out = (await c.read())!;
    expect(out.title).toBe("Standup");
    expect(out.segments[0].text).toBe("hi");
    expect(out.segments[0].speaker_id).toBe(out.participants[0].id);
    expect(JSON.stringify(out)).not.toContain(c.user);
    expect(JSON.stringify(out)).not.toContain(c.roomKey);
  });

  test("a deleted team's call serves nothing, and a restore brings the link back", async () => {
    const c = await linkedCall("deleted-team");
    expect(await c.read()).toBeNull();
    await c.t.run(({ db }) => db.patch(c.team, { deleted_at: undefined }));
    expect((await c.read())?.status).toBe("ended");
  });

  test("an unknown token is null", async () => {
    const { t } = await linkedCall("words");
    expect(
      await t.query(api.publicShare.getSharedCall, { share_token: UUID_B }),
    ).toBeNull();
  });

  test("a recording is served through the link-checked route, and dies with the link", async () => {
    const c = await linkedCall("audio");
    const out = (await c.read())!;
    expect(out.recording_url).toContain(
      `${SHARED_CALL_AUDIO_PATH}?token=${UUID_A}`,
    );
    const storageUrl = (await c.t.run(({ storage }) =>
      storage.getUrl(c.audio!),
    ))!;
    expect(storageUrl).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain(storageUrl);
    expect(await c.audioSource()).toBe(storageUrl);
    await c.t.run(({ db }) => db.patch(c.call, { share_token: undefined }));
    expect(await c.audioSource()).toBeNull();
  });

  test("an audio range is clamped to one response's size", () => {
    expect(clampAudioRange(null, 100)).toBe("bytes=0-99");
    expect(clampAudioRange("bytes=50-", 100)).toBe("bytes=50-149");
    expect(clampAudioRange("bytes=10-20", 100)).toBe("bytes=10-20");
    expect(clampAudioRange("garbage", 100)).toBe("bytes=0-99");
  });
});

describe("getSharedProject", () => {
  test("carries only the work filed in the project's own workspace", async () => {
    const t = serverTest();
    const owner = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "shared project");
      const owner = await rows.user({ name: "Ada" });
      const other = await rows.user();
      const team = await rows.team();
      const workspace = `team:${team}`;
      const project_id = await db.insert("projects", {
        user_id: owner,
        team_id: team,
        workspace,
        title: "Launch",
        status: "active",
        share_token: UUID_A,
        created_at: 1,
        updated_at: 2,
      });
      await rows.task(owner, { project_id, workspace, title: "Ours" });
      await rows.task(other, { project_id, title: "Someone's private" });
      return owner;
    });
    const out = (await t.query(api.publicShare.getSharedProject, {
      share_token: UUID_A,
    }))!;
    expect(out.title).toBe("Launch");
    expect(out.tasks.map((task) => task.title)).toEqual(["Ours"]);
    expect(JSON.stringify(out)).not.toContain(owner);
  });
});
