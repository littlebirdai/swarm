import { asUser, serverTest } from "./database.testkit";
import { fixtureRows, type NewRow } from "./rows.testkit";

export async function taskTest(
  seed: string,
  token: string,
  tasks: Partial<NewRow<"tasks">>[] = [],
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, seed);
    const owner = await rows.user({ github_username: "owner" });
    const bob = await rows.user({ github_username: "bob" });
    await rows.token(owner, token);
    const session = await rows.conversation(owner, { session_id: "sess-1" });
    const taskIds = [];
    for (const fields of tasks) taskIds.push(await rows.task(owner, fields));
    return { owner, bob, session, taskIds };
  });
  return {
    t,
    web: asUser(t, ids.owner),
    ...ids,
    subscriptions: () =>
      t.run(({ db }) => db.query("entity_subscriptions").collect()),
  };
}
