import type { Doc } from "../convex/_generated/dataModel";
import { asUser, serverTest } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";

export const source = "source";
export const destination = "destination";
export const sessionId = "session-to-move";
export const projectPath = "/repos/project";
export const refusal =
  "This session uses fenced execution and cannot move to another device or account.";

export async function moveFixture(fields: Partial<Doc<"conversations">> = {}) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "device move");
    const user = await rows.user();
    await rows.device(user, { device_id: source });
    await rows.device(user, { device_id: destination, last_seen: Date.now() });
    const conversation = await rows.conversation(user, {
      session_id: sessionId,
      owner_device_id: source,
      ...fields,
    });
    return { user, conversation };
  });
  return {
    ...ids,
    t,
    caller: asUser(t, ids.user),
    read: () => t.run(({ db }) => db.get(ids.conversation)),
    commands: () => t.run(({ db }) => db.query("daemon_commands").collect()),
  };
}
