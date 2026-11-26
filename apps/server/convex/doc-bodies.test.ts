import { expect, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

test("body prefetch omits an archived doc from a previously loaded list", async () => {
  const t = serverTest();
  const { owner, live, archived } = await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "body prefetch");
    const owner = await fixtures.user();
    const live = await fixtures.doc(owner, { content: "Live body" });
    const archived = await fixtures.doc(owner, {
      content: "Archived body",
      archived_at: 1,
    });
    return { owner, live, archived };
  });
  const { bodies } = await asUser(t, owner).query(api.docs.webGetBodies, {
    ids: [live, archived],
  });
  expect(bodies).toEqual([
    expect.objectContaining({ _id: live, content: "Live body" }),
  ]);
});
