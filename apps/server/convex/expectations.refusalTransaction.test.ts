import { expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

async function refuseStaleProposal() {
  const t = serverTest();
  const token = "expectation-refusal-token";
  await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "expectation refusal");
    const user = await rows.user();
    await rows.token(user, token);
    await db.insert("projects", {
      user_id: user,
      workspace: `user:${user}`,
      short_id: "pj-1",
      title: "Calls",
      status: "active",
      created_at: 1,
      updated_at: 1,
    });
  });
  const scope = {
    api_token: token,
    workspace: "personal",
    project: "pj-1",
  } as const;
  const citations = [{ kind: "commit" as const, ref: "um@0274603e1d" }];
  const { short_id: seed } = await t.mutation(api.expectations.propose, {
    ...scope,
    summary: "Seed",
    ops: [{ op: "add", part: "Calls", text: "The facts are true.", citations }],
    hold: true,
  });
  const apply = (proposal: string) =>
    t.mutation(api.expectations.resolve, {
      api_token: token,
      proposal,
      action: "apply",
    });
  await apply(seed);
  const seeded = await t.query(api.expectations.show, scope);
  const line = seeded.doc!.items[0].id;
  const { short_id: edit } = await t.mutation(api.expectations.propose, {
    ...scope,
    summary: "Edit",
    ops: [
      {
        op: "edit",
        id: line,
        text: "The facts are true for every call.",
        citations,
      },
    ],
  });
  const { short_id: retire } = await t.mutation(api.expectations.propose, {
    ...scope,
    summary: "Retire",
    ops: [{ op: "retire", id: line, reason: "gone", citations }],
  });
  await apply(edit);
  await expect(apply(retire)).rejects.toThrow("changed in version 2");
  const latest = await t.query(api.expectations.show, scope);
  return {
    version: latest.current_version,
    proposal: latest.proposals.find((p) => p.short_id === retire),
  };
}

test("a stale proposal is refused without advancing the document", async () => {
  const { version, proposal } = await refuseStaleProposal();
  expect(version).toBe(2);
  expect(proposal?.status).toBe("open");
});

test.failing(
  "the proposal keeps the refusal reason after its mutation throws",
  async () => {
    const { proposal } = await refuseStaleProposal();
    expect(proposal?.refused).toContain("changed in version 2");
  },
);
