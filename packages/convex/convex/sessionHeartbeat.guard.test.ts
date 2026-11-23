import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const schemaAndStorage = new Set(["schema.ts", "lib/sessionHeartbeat.ts"]);
const otherHeartbeats = new Set(["daemonLogs.ts", "users.ts"]);
const wireFields: Record<string, string[]> = {
  "conversations.ts": [
    'for (const k of ["updated_at", "message_count", "last_message_at", "last_metrics_at", "last_active_at", "last_heartbeat"]) {',
    "last_heartbeat: maps.lastHeartbeatMap.get(conv._id.toString()) ?? null,",
    "last_heartbeat: maps.lastHeartbeatMap.get(child._id.toString()) ?? null,",
    "last_heartbeat: number | null;",
    "rowLiveDeadlines({ updated_at: c.updated_at, last_heartbeat: maps.lastHeartbeatMap?.get(c._id.toString()) ?? null }));",
    '"open_tasks", "open_tasks_at", "producing_until", "last_heartbeat",',
    "last_heartbeat: lv.last_heartbeat ?? null,",
    "last_heartbeat: maps.lastHeartbeatMap.get(cid) ?? null,",
    "last_heartbeat: facts.last_heartbeat,",
  ],
  "debugTmp.ts": ["last_heartbeat: await heartbeatOf(ctx, managed),"],
  "managedSessions.ts": [
    "last_heartbeat: now,",
    "last_heartbeat: 0,",
    "session: { agent_status?: string; agent_status_updated_at?: number; agent_status_write_at?: number; last_heartbeat?: number },",
    "const heartbeatStale = !session.last_heartbeat || now - session.last_heartbeat > HEARTBEAT_REFRESH_MS;",
    "patch.last_heartbeat = now;",
    "await writeSessionHeartbeat(ctx, session._id, session.user_id, patch?.last_heartbeat ?? session.last_heartbeat);",
    "patch.last_heartbeat = at;",
    "last_heartbeat: lastHeartbeat,",
  ],
  "managedSessionsList.ts": ["last_heartbeat: await heartbeatOf(ctx, session),"],
  "lib/closeAside.ts": [
    "last_heartbeat: lastHeartbeat,",
    "openBackgroundWork = openTasksVouchForWaiting(managed.open_tasks_at, managed.open_tasks?.length ?? 0, rowHeartbeatAliveAt({ last_heartbeat: lastHeartbeat }, now));",
  ],
  "syncLog.ts": ['"last_heartbeat",'],
  "permissions.ts": ["const lastBeat = device ? device.last_seen : conv ? (await ctx.db.get(conv.user_id))?.last_heartbeat : undefined;"],
  "tasks.ts": ["const updates: any = { last_heartbeat: Date.now() };"],
};

test("managed-session heartbeat storage is accessed through sessionHeartbeat", () => {
  const violations: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
    if (file.startsWith("_generated/") || /\.(test|testkit|d)\.ts$/.test(file)) continue;
    if (schemaAndStorage.has(file)) continue;
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    source.split("\n").forEach((line, i) => {
      const text = line.trim();
      if (text.startsWith("//")) return;
      if (/\bsession_heartbeats\b|\bby_user_heartbeat\b|\bby_heartbeat\b/.test(text) ||
        (/\blast_heartbeat\b/.test(text) && !otherHeartbeats.has(file) && !wireFields[file]?.includes(text))) {
        violations.push(`${file}:${i + 1} ${text}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
