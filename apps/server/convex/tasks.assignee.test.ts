import type { MutationCtx } from "./_generated/server";
import { describe, expect, test } from "bun:test";
import { resolveAssigneeStr, resolveAssigneeToUserId } from "./tasks";

import {
  serverTest,
  strictDatabaseGet,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

async function makeTeam() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "assignee roster");
    const teamId = await rows.team();
    const jason = await rows.user({
      name: "Jason Benn",
      email: "jasoncbenn@gmail.com",
      alternate_emails: ["jason@union.app"],
      active_team_id: teamId,
    });
    const ashot = await rows.user({
      name: "Ashot",
      github_username: "ashot",
      active_team_id: teamId,
    });
    await rows.membership(jason, teamId);
    await rows.membership(ashot, teamId);
    return { teamId, jason, ashot };
  });
  return { t, ...ids };
}

function withStrictGet(ctx: MutationCtx) {
  return { ...ctx, db: strictDatabaseGet(ctx.db) };
}

describe("resolveAssigneeToUserId", () => {
  test("does not throw on a raw name; resolves Jason by exact name", async () => {
    const { t, teamId, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), "Jason Benn", teamId),
      ),
    ).toBe(jason);
  });

  test("resolves a partial first name via unique substring", async () => {
    const { t, teamId, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), "jason", teamId),
      ),
    ).toBe(jason);
  });

  test("resolves by primary email", async () => {
    const { t, teamId, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(
          withStrictGet(ctx),
          "jasoncbenn@gmail.com",
          teamId,
        ),
      ),
    ).toBe(jason);
  });

  test("resolves by alternate email", async () => {
    const { t, teamId, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), "jason@union.app", teamId),
      ),
    ).toBe(jason);
  });

  test("still resolves github-handle members (Ashot)", async () => {
    const { t, teamId, ashot } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), "ashot", teamId),
      ),
    ).toBe(ashot);
  });

  test("resolves a real user id directly", async () => {
    const { t, teamId, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), jason, teamId),
      ),
    ).toBe(jason);
  });

  test("returns null for an unknown name instead of throwing", async () => {
    const { t, teamId } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), "Nobody Here", teamId),
      ),
    ).toBeNull();
  });

  test("returns null for an ambiguous substring (never guesses)", async () => {
    const t = serverTest();
    const teamId = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "ambiguous roster");
      const team = await rows.team();
      for (const name of ["Jordan Lee", "Jordan Park"]) {
        await rows.membership(
          await rows.user({ name, active_team_id: team }),
          team,
        );
      }
      return team;
    });
    expect(
      await t.run((ctx) =>
        resolveAssigneeToUserId(withStrictGet(ctx), "Jordan", teamId),
      ),
    ).toBeNull();
  });
});

describe("resolveAssigneeStr", () => {
  // A name is looked up on the roster of the boundary the caller names. A
  // write never guesses a team from the actor's active team pointer
  // (CLAUDE.md: reads may default, writes must be explicit).
  test("persists a real user id for a friendly name (Jason Benn)", async () => {
    const { t, jason, teamId } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeStr(withStrictGet(ctx), "Jason Benn", jason, {
          team_id: teamId,
        }),
      ),
    ).toBe(jason);
  });

  test("persists a real user id for a partial name (jason)", async () => {
    const { t, jason, teamId } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeStr(withStrictGet(ctx), "jason", jason, {
          team_id: teamId,
        }),
      ),
    ).toBe(jason);
  });

  test("with no boundary a name is kept as typed, never resolved against a guessed team", async () => {
    const { t, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeStr(withStrictGet(ctx), "Jason Benn", jason),
      ),
    ).toBe("Jason Benn");
  });

  test("resolves github-handle members to their id (ashot)", async () => {
    const { t, ashot } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeStr(withStrictGet(ctx), "ashot", ashot),
      ),
    ).toBe(ashot);
  });

  test("'me' maps to the acting user id", async () => {
    const { t, jason } = await makeTeam();
    expect(
      await t.run((ctx) => resolveAssigneeStr(withStrictGet(ctx), "me", jason)),
    ).toBe(jason);
  });

  test("keeps the raw string when nothing matches", async () => {
    const { t, jason } = await makeTeam();
    expect(
      await t.run((ctx) =>
        resolveAssigneeStr(withStrictGet(ctx), "Nobody Here", jason),
      ),
    ).toBe("Nobody Here");
  });
});
