import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const schemaAndStorage = new Set(["schema.ts", "lib/sessionHeartbeat.ts"]);
const otherHeartbeats = new Set(["daemonLogs.ts", "users.ts"]);
const wireFields: Record<string, string[]> = {
  "conversations.ts": [
    "last_heartbeat: maps.lastHeartbeatMap.get(conv._id.toString()) ?? null,",
    "last_heartbeat: maps.lastHeartbeatMap.get(child._id.toString()) ?? null,",
    "last_heartbeat: number | null;",
    "last_heartbeat: maps.lastHeartbeatMap?.get(c._id.toString()) ?? null,",
    '"last_heartbeat",',
    "last_heartbeat: lv.last_heartbeat ?? null,",
    "last_heartbeat: maps.lastHeartbeatMap.get(cid) ?? null,",
    "last_heartbeat: facts.last_heartbeat,",
  ],
  "debugTmp.ts": ["last_heartbeat: await heartbeatOf(ctx, managed),"],
  "managedSessions.ts": [
    "last_heartbeat: now,",
    "last_heartbeat: 0,",
    "patch?.last_heartbeat ?? session.last_heartbeat,",
    "patch.last_heartbeat = at;",
    "last_heartbeat: lastHeartbeat,",
  ],
  "lib/heartbeatPatch.ts": [
    "session: StatusStamps & { last_heartbeat?: number },",
    "!session.last_heartbeat ||",
    "now - session.last_heartbeat > HEARTBEAT_REFRESH_MS;",
    "patch.last_heartbeat = now;",
  ],
  "managedSessionsList.ts": [
    "last_heartbeat: await heartbeatOf(ctx, session),",
  ],
  "lib/closeAside.ts": [
    "last_heartbeat: lastHeartbeat,",
    "rowHeartbeatAliveAt({ last_heartbeat: lastHeartbeat }, now),",
  ],
  "syncLog.ts": ['"last_heartbeat",'],
  "permissions.ts": ["? (await ctx.db.get(conv.user_id))?.last_heartbeat"],
  "tasks.ts": ["const updates: any = { last_heartbeat: Date.now() };"],
};

test("managed-session heartbeat storage is accessed through sessionHeartbeat", () => {
  const violations: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
    if (file.startsWith("_generated/") || /\.(test|testkit|d)\.ts$/.test(file))
      continue;
    if (schemaAndStorage.has(file)) continue;
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    source.split("\n").forEach((line, i) => {
      const text = line.trim();
      if (text.startsWith("//")) return;
      if (
        /\bsession_heartbeats\b|\bby_user_heartbeat\b|\bby_heartbeat\b/.test(
          text,
        ) ||
        (/\blast_heartbeat\b/.test(text) &&
          !otherHeartbeats.has(file) &&
          !wireFields[file]?.includes(text))
      ) {
        violations.push(`${file}:${i + 1} ${text}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
