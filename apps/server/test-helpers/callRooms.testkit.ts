import { serverTest } from "./database.testkit";
import { fixtureRows, type NewRow } from "./rows.testkit";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import {
  authorizeRoom,
  authorizeRoomInviter,
  authorizeRoomMembership,
  authorizeRoomNoGrant,
  clearRoomState,
  dmRoomKey,
  expireRoomGrants,
  isRoomLocked,
  openRoomDoor,
  parseRoomKey,
} from "../convex/callRooms";
import { canReadCall } from "../convex/transcripts";

export const TEAM = "team1";
export const membership = (
  user_id: string,
  team_id = TEAM,
  visibility?: NewRow<"team_memberships">["visibility"],
) => ({
  user_id,
  team_id,
  visibility,
});

type Named = { _id?: string };
type Seed<
  T extends TableNames,
  References extends keyof NewRow<T> = never,
> = Partial<Omit<NewRow<T>, References>> &
  Partial<Record<References, string>> &
  Named;

type Roster = {
  teams?: Seed<"teams">[];
  users?: Seed<"users", "active_team_id" | "team_id">[];
  team_memberships?: ReturnType<typeof membership>[];
  conversations?: Seed<"conversations", "user_id" | "team_id">[];
  chat_channels?: Seed<"chat_channels", "team_id">[];
  chat_channel_members?: Seed<
    "chat_channel_members",
    "channel_id" | "user_id"
  >[];
  call_members?: Seed<"call_members", "team_id" | "user_id">[];
  call_room_state?: Seed<"call_room_state", "team_id" | "locked_by">[];
  call_invites?: Seed<"call_invites", "team_id" | "from_user" | "to_user">[];
  call_knocks?: Seed<"call_knocks", "team_id" | "from_user">[];
  transcripts?: Seed<"transcripts", "team_id" | "started_by">[];
};

function roomFor(
  key: string,
  ids: {
    users: Record<string, Id<"users">>;
    channels: Record<string, Id<"chat_channels">>;
    sessions: Record<string, Id<"conversations">>;
  },
) {
  const parsed = parseRoomKey(key);
  switch (parsed?.kind) {
    case "dm":
      return dmRoomKey(parsed.users.map((user) => ids.users[user]));
    case "channel":
      return `channel:${ids.channels[parsed.channelId] ?? parsed.channelId}`;
    case "session":
      return `session:${ids.sessions[parsed.conversationId] ?? parsed.conversationId}`;
    default:
      return key;
  }
}

export async function setup(seed: Roster = {}) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "call room roster");
    const teams: Record<string, Id<"teams">> = {};
    for (const tag of [TEAM, "team2", "team-off", "team-gone"]) {
      const { _id, ...fields } =
        seed.teams?.find((team) => team._id === tag) ?? {};
      teams[tag] = await rows.team(fields);
    }
    const users: Record<string, Id<"users">> = {};
    for (const tag of [
      "ua",
      "ub",
      "uc",
      "ud",
      "ue",
      "ux",
      "uz",
      "owner",
      "mate",
    ]) {
      const { _id, team_id, active_team_id, ...fields } =
        seed.users?.find((user) => user._id === tag) ?? {};
      users[tag] = await rows.user({
        ...fields,
        team_id: team_id ? teams[team_id] : undefined,
        active_team_id: active_team_id ? teams[active_team_id] : undefined,
      });
    }
    for (const { user_id, team_id, visibility } of seed.team_memberships ?? [])
      await rows.membership(users[user_id], teams[team_id], { visibility });
    const sessions: Record<string, Id<"conversations">> = {};
    for (const { _id, user_id, team_id, ...fields } of seed.conversations ??
      []) {
      sessions[_id!] = await rows.conversation(users[user_id ?? "ua"], {
        team_id: team_id ? teams[team_id] : undefined,
        ...fields,
      });
    }
    sessions.none = await rows.conversation(users.ua);
    await db.delete(sessions.none);
    const channels: Record<string, Id<"chat_channels">> = {};
    for (const { _id, team_id, ...fields } of seed.chat_channels ?? []) {
      channels[_id!] = await db.insert("chat_channels", {
        team_id: teams[team_id ?? TEAM],
        name: "General",
        created_by: users.ua,
        created_at: 1,
        updated_at: 1,
        ...fields,
      });
    }
    for (const { channel_id, user_id } of seed.chat_channel_members ?? [])
      await db.insert("chat_channel_members", {
        channel_id: channels[channel_id!],
        user_id: users[user_id!],
        added_by: users.ua,
        added_at: 1,
      });
    const key = (room_key: string) =>
      roomFor(room_key, { users, channels, sessions });
    const now = Date.now();
    for (const {
      _id,
      room_key,
      team_id,
      user_id,
      ...fields
    } of seed.call_members ?? [])
      await db.insert("call_members", {
        room_key: key(room_key!),
        team_id: teams[team_id ?? TEAM],
        user_id: users[user_id!],
        user_name: user_id!,
        joined_at: now,
        last_seen: now,
        muted: false,
        camera: false,
        sharing: false,
        ...fields,
      });
    for (const {
      _id,
      room_key,
      team_id,
      locked_by,
      ...fields
    } of seed.call_room_state ?? [])
      await db.insert("call_room_state", {
        room_key: key(room_key!),
        team_id: teams[team_id ?? TEAM],
        locked_by: users[locked_by!],
        updated_at: now,
        locked: true,
        ...fields,
      });
    for (const {
      _id,
      room_key,
      team_id,
      from_user,
      to_user,
      ...fields
    } of seed.call_invites ?? [])
      await db.insert("call_invites", {
        room_key: key(room_key!),
        team_id: teams[team_id ?? TEAM],
        from_user: users[from_user!],
        to_user: users[to_user!],
        status: "ringing",
        created_at: now,
        ...fields,
      });
    for (const {
      _id,
      room_key,
      team_id,
      from_user,
      ...fields
    } of seed.call_knocks ?? [])
      await db.insert("call_knocks", {
        room_key: key(room_key!),
        team_id: teams[team_id ?? TEAM],
        from_user: users[from_user!],
        created_at: now,
        ...fields,
      });
    for (const {
      _id,
      room_key,
      team_id,
      started_by,
      ...fields
    } of seed.transcripts ?? [])
      await db.insert("transcripts", {
        room_key: key(room_key!),
        team_id: teams[team_id ?? TEAM],
        started_by: users[started_by!],
        status: "live",
        routes: [],
        started_at: now,
        last_seq: 0,
        ...fields,
      });
    return { users, teams, sessions, channels };
  });
  const key = (room: string) => roomFor(room, ids);
  const user = (name: string) => ids.users[name];
  return {
    ...ids,
    t,
    key,
    user,
    team: ids.teams[TEAM],
    authorize: (
      name: string,
      room: string,
      opts?: Parameters<typeof authorizeRoom>[3],
    ) => t.query((ctx) => authorizeRoom(ctx, user(name), key(room), opts)),
    inviter: (name: string, room: string) =>
      t.query((ctx) => authorizeRoomInviter(ctx, user(name), key(room))),
    membership: (name: string, room: string) =>
      t.query((ctx) => authorizeRoomMembership(ctx, user(name), key(room))),
    noGrant: (name: string, room: string) =>
      t.query((ctx) => authorizeRoomNoGrant(ctx, user(name), key(room))),
    open: (
      name: string,
      room: string,
      opts?: Parameters<typeof openRoomDoor>[3],
    ) => t.query((ctx) => openRoomDoor(ctx, user(name), key(room), opts)),
    locked: (room: string) => t.query((ctx) => isRoomLocked(ctx, key(room))),
    expire: (room: string) =>
      t.mutation((ctx) => expireRoomGrants(ctx, key(room))),
    clear: (room: string) =>
      t.mutation((ctx) => clearRoomState(ctx, key(room))),
    read: <Table extends TableNames>(table: Table) =>
      t.run(({ db }) => db.query(table).collect()),
    canRead: (name: string, room: string) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert("transcripts", {
          team_id: ids.teams[TEAM],
          room_key: key(room),
          started_by: user("owner"),
          status: "ended",
          routes: [],
          started_at: 1,
          last_seq: 0,
        });
        return canReadCall(ctx, user(name), (await ctx.db.get(id))!);
      }),
  };
}
