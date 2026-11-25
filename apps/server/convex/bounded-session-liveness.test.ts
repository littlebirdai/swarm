import { expect, spyOn, test } from "bun:test";
import { getDocumentSize, type Value } from "convex/values";
import { api } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { HEARTBEAT_ALIVE_MS } from "./inboxFilters";
import {
  classifyWorkStates,
  computeInboxSessions,
  computeSessionsLiveness,
} from "./conversations";
import {
  asUser,
  countDatabaseReads,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const minute = 60_000;
const day = 86_400_000;
const epoch = 1_800_000_000_000;

const legacyDigests = [
  "e0a6cde2e90c72434c0b1b94058f8729301242758170f2b98a64dd6280b19624",
  "fd7011a8d3772c06867456f926aafdf286d3567c420897fca78ea8758080a9ac",
  "73976dfb0105eb70186de956ae43ea76972398fca4398a645f0d9f10f5139440",
  "64ad04589c33f20337c9c2b976f7b29dd53c9a5858545837d053f175e3896591",
];

test.each(legacyDigests.map((digest, seed) => ({ seed, digest })))(
  "preserves legacy liveness payloads for seed $seed",
  async ({ seed, digest }) => {
    const t = serverTest();
    const clock = spyOn(Date, "now").mockReturnValue(epoch + 23_000);
    try {
      const { user, parent, orgChildren } = await t.run(async ({ db }) => {
        const rows = fixtureRows(db, `liveness-parity-${seed}`);
        const user = await rows.user();
        const otherUser = await rows.user();
        const devices = ["local", "remote", "build"];
        for (const device_id of devices) await rows.device(user, { device_id });
        const parentId = await rows.conversation(user, {
          updated_at: epoch - minute,
          message_count: 1,
          last_message_role: "assistant",
          is_favorite: true,
        });
        const parent = (await db.get(parentId))!;
        const orgChildren = [];
        const count = seed === 3 ? 550 : 18;
        for (let i = 0; i < count; i++) {
          const overflow = seed === 3 && i >= 18;
          const stale = i % 3 === 0 || seed === 1;
          const updated =
            overflow || i === 0 ? epoch - 40 * day : epoch - i * minute;
          const conversation = await rows.conversation(user, {
            updated_at: updated,
            message_count: 1,
            last_message_role: "assistant",
            is_favorite: i === 0 || i === 3,
            owner_device_id: devices[i % devices.length],
            inbox_dismissed_at: i === 1 ? epoch - day : undefined,
            inbox_stashed_at: i === 2 ? epoch - day : undefined,
            parent_conversation_id: overflow || i >= 12 ? parentId : undefined,
            is_subagent: overflow || i >= 12 ? true : undefined,
          });
          if (i === 12 || i === 13)
            orgChildren.push((await db.get(conversation))!);
          const beat = overflow
            ? epoch - 1
            : stale
              ? epoch - 15 * minute + i
              : epoch - HEARTBEAT_ALIVE_MS + (i % 3) - 1;
          const sideOnly = i % 4 === 2;
          const daemon = seed !== 1 || i === 7;
          const id = await rows.session(user, {
            conversation_id: conversation,
            last_heartbeat: sideOnly ? epoch - 40 * day : beat,
            agent_status: overflow
              ? "done"
              : (
                  [
                    "working",
                    "idle",
                    "done",
                    "waiting",
                    "hibernated",
                    "permission_blocked",
                  ] as const
                )[i % 6],
            agent_status_updated_at: updated - 2 * minute,
            agent_status_boundary: i % 2 === 0 ? true : undefined,
            turn_completed_at: updated - minute,
            hibernated_at: i % 6 === 4 ? updated : undefined,
            hosted: daemon ? undefined : i % 2 === 0,
          });
          if (i % 4 !== 0)
            await db.insert("session_heartbeats", {
              managed_session_id: id,
              user_id: user,
              heartbeat_at: beat + (i % 4 === 1 ? -15 : 0),
            });
          if (i === 12) {
            await rows.session(user, {
              conversation_id: conversation,
              last_heartbeat: epoch - day,
              agent_status: "stopped",
              agent_status_updated_at: epoch - day,
            });
            await rows.session(otherUser, {
              conversation_id: conversation,
              last_heartbeat: epoch,
              agent_status: "permission_blocked",
            });
          }
        }
        const unlinked = await rows.session(user, {
          last_heartbeat: seed === 1 ? epoch - 20 * minute : epoch - 2 * minute,
        });
        await db.insert("session_heartbeats", {
          user_id: user,
          managed_session_id: unlinked,
          heartbeat_at: seed === 1 ? epoch - 8 * minute : epoch - 70_000,
        });
        if (seed === 1) {
          const hosted = await rows.session(user, {
            last_heartbeat: epoch - minute,
            hosted: true,
          });
          await db.insert("session_heartbeats", {
            user_id: user,
            managed_session_id: hosted,
            heartbeat_at: epoch - minute,
          });
        }
        return { user, parent, orgChildren };
      });

      const payloads = [];
      for (const now of [epoch + 23_000, epoch + minute, epoch + 6 * minute]) {
        clock.mockReturnValue(now);
        payloads.push(
          await t.run(async (ctx) => ({
            overlay: await computeSessionsLiveness(ctx, user),
            inbox: await computeInboxSessions(ctx, user, {
              projection: true,
              show_all: true,
            }),
            org: [
              ...(await classifyWorkStates(
                ctx,
                user,
                [parent, ...orgChildren],
                new Map([[parent._id, orgChildren]]),
                now,
              )),
            ],
          })),
        );
        payloads.push(
          await asUser(t, user).query(
            api.conversations.listFavoriteSessions,
            {},
          ),
        );
      }
      const actual = Bun.CryptoHasher.hash(
        "sha256",
        JSON.stringify(payloads),
        "hex",
      );
      expect(actual).toBe(digest);
    } finally {
      clock.mockRestore();
    }
  },
);

function measureReads(db: DatabaseReader) {
  const counted = countDatabaseReads(db);
  const documents = { count: 0, bytes: 0 };
  const record = (row: Record<string, Value> | null) => {
    if (row === null) return;
    documents.count++;
    documents.bytes += getDocumentSize(row);
  };
  const observeQuery = (query: object): object =>
    new Proxy(query, {
      get(target, key) {
        if (key === Symbol.asyncIterator) {
          return async function* () {
            for await (const row of target as AsyncIterable<
              Record<string, Value>
            >) {
              record(row);
              yield row;
            }
          };
        }
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          if (["collect", "first", "take", "unique"].includes(String(key))) {
            return result.then(
              (
                rows: Record<string, Value> | null | Record<string, Value>[],
              ) => {
                for (const row of Array.isArray(rows) ? rows : [rows])
                  record(row);
                return rows;
              },
            );
          }
          return observeQuery(result);
        };
      },
    });

  const observed: DatabaseReader = {
    ...counted.db,
    get: async (...args: [Id<TableNames>] | [TableNames, Id<TableNames>]) => {
      const row = await (args.length === 1
        ? counted.db.get(args[0])
        : counted.db.get(args[0], args[1]));
      record(row);
      return row;
    },
    query: (table) => {
      const query = counted.db.query(table);
      return observeQuery(query) as typeof query;
    },
  };
  return { db: observed, documents, calls: counted.reads };
}

test.each([
  { kind: "daemon", hosted: undefined },
  { kind: "hosted", hosted: true },
])(
  "unrelated dead $kind sessions leave overlay reads unchanged",
  async ({ hosted }) => {
    const t = serverTest();
    const clock = spyOn(Date, "now").mockReturnValue(epoch + 23_000);
    try {
      const user = await t.run(async ({ db }) => {
        const rows = fixtureRows(db, "liveness-cost-live");
        const user = await rows.user();
        for (let i = 0; i < 20; i++) {
          const conversation = await rows.conversation(user, {
            updated_at: epoch,
          });
          const session = await rows.session(user, {
            conversation_id: conversation,
            last_heartbeat: epoch,
            agent_status: "idle",
            agent_status_updated_at: epoch,
            hosted,
          });
          await db.insert("session_heartbeats", {
            managed_session_id: session,
            user_id: user,
            heartbeat_at: epoch,
          });
        }
        return user;
      });
      const addDead = (count: number) =>
        t.run(async ({ db }) => {
          const rows = fixtureRows(db, `liveness-cost-dead-${count}`);
          const at = epoch - 40 * day;
          for (let i = 0; i < count; i++) {
            const conversation = await rows.conversation(user, {
              updated_at: at,
            });
            const session = await rows.session(user, {
              conversation_id: conversation,
              last_heartbeat: at,
              agent_status: "done",
              agent_status_updated_at: at,
              hosted,
            });
            await db.insert("session_heartbeats", {
              managed_session_id: session,
              user_id: user,
              heartbeat_at: at,
            });
          }
        });
      const measure = () =>
        t.run(async (ctx) => {
          const measured = measureReads(ctx.db);
          const overlay = await computeSessionsLiveness(
            { ...ctx, db: measured.db },
            user,
          );
          return {
            overlay,
            ...measured.documents,
            calls: measured.calls.length,
          };
        });
      await addDead(200);
      const small = await measure();
      await addDead(1780);
      const total2000 = await measure();
      await addDead(20);
      const large = await measure();
      expect(Object.keys(small.overlay.liveness)).toHaveLength(20);
      expect(total2000).toEqual(small);
      expect(large).toEqual(small);
    } finally {
      clock.mockRestore();
    }
  },
);
