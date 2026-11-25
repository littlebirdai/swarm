import { expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";

test("merging accounts collapses duplicate limiter rows and preserves both high-water marks", async () => {
  const t = serverTest();
  const endpoint = "relayGrants.mint";
  const now = Date.now();
  const { from, to } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "limiter-merge");
    const from = await rows.user();
    const to = await rows.user();
    await db.insert("rate_limits", {
      user_id: from,
      endpoint,
      window_start: now - 5000,
      request_count: 20,
      last_request_at: now,
      sequence: now + 1,
    });
    await db.insert("rate_limits", {
      user_id: to,
      endpoint,
      window_start: now - 2000,
      request_count: 25,
      last_request_at: now - 1,
      sequence: now + 10,
    });
    await db.insert("rate_limits", {
      user_id: to,
      endpoint,
      window_start: now - 120_000,
      request_count: 120,
    });
    await db.insert("rate_limits", {
      user_id: from,
      endpoint: "chat.send",
      window_start: now,
      request_count: 4,
    });
    return { from, to };
  });

  const counters = () => t.run(({ db }) => db.query("rate_limits").collect());
  const fixture = await counters();
  await t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
    from_user_id: from,
    to_user_id: to,
    dry_run: true,
  });
  expect(await counters()).toEqual(fixture);
  await t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
    from_user_id: from,
    to_user_id: to,
    dry_run: false,
    delete_source: true,
  });
  const merged = await counters();
  expect(merged).toHaveLength(2);
  expect(merged.find((row) => row.endpoint === endpoint)).toMatchObject({
    user_id: to,
    window_start: now - 2000,
    request_count: 45,
    last_request_at: now,
    sequence: now + 10,
  });
  expect(merged.find((row) => row.endpoint === "chat.send")).toMatchObject({
    user_id: to,
    request_count: 4,
  });
});
