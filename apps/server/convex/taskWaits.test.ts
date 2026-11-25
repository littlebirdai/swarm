// Waits (docs/architecture/task-graph.md TG2): a wait checks its target when it
// is set, settles on the PR, decision or time event it names, and the moment a
// task's last blocker clears (a wait, or a blocker task closing) the task is
// told once and its owning session is woken.
import { describe, expect, test } from "bun:test";
import {
  REPO,
  USER,
  decision,
  owner,
  pr,
  setup,
  task,
  waitClock,
} from "../test-helpers/taskWaits.testkit";

import { api } from "./_generated/api";

waitClock();

describe("setting a wait", () => {
  test("a PR still open waits, and the task enters by_waiting_since", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    const res = await c.add({
      short_id: "ct-1",
      ref: `${REPO}#42`,
    });
    expect(res.met).toBe(false);
    expect(res.wait).toMatchObject({
      kind: "pr_merged",
      repository: REPO,
      pr_number: 42,
      state: "waiting",
      created_by: c.user,
    });
    expect((await c.row("ct-1")).waiting_since).toBeNumber();
    expect(
      (await c.read("task_history")).map((h) => [
        h.field,
        h.old_value,
        h.new_value,
      ]),
    ).toEqual([["waits", "", "Waiting on PR #42"]]);
  });

  test("a PR already merged is met at once and says so", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42, { state: "merged" })],
    });
    const res = await c.add({
      short_id: "ct-1",
      ref: `${REPO}#42`,
    });
    expect(res.met).toBe(true);
    expect(res.wait).toMatchObject({ state: "met", note: "already merged" });
    expect((await c.row("ct-1")).waiting_since).toBeUndefined();
    // A retry on the met target is the same wait, with no second history line.
    expect(await c.add({ short_id: "ct-1", ref: `${REPO}#42` })).toMatchObject({
      existing: true,
      met: true,
      wait: { id: res.wait.id },
    });
    expect((await c.row("ct-1")).waits).toHaveLength(1);
    expect(await c.read("task_history")).toHaveLength(1);
  });

  test("checks already green meet a checks wait at once", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42, { checks_state: "success" })],
    });
    const res = await c.add({
      short_id: "ct-1",
      ref: `${REPO}#42:checks`,
    });
    expect(res.wait).toMatchObject({
      kind: "pr_checks_green",
      state: "met",
      note: "already green",
    });
  });

  test("a PR codecast cannot see is refused with the reason", async () => {
    const c = await setup({ tasks: [task("ct-1")] });
    await expect(c.add({ short_id: "ct-1", ref: `${REPO}#7` })).rejects.toThrow(
      "codecast cannot see PR acme/app#7: no GitHub app installation of yours covers acme/app.",
    );
    expect((await c.row("ct-1")).waits).toBeUndefined();
  });

  test("in a repository an installation covers, only the PR itself is in doubt", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      github_app_installations: [
        {
          _id: "inst_1",
          scope_user_id: USER,
          installation_id: 1,
          account_login: "acme",
          account_type: "Organization",
          account_id: 1,
          repository_selection: "all",
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    await expect(c.add({ short_id: "ct-1", ref: `${REPO}#7` })).rejects.toThrow(
      "codecast cannot see PR acme/app#7: it has not synced, or does not exist.",
    );
  });

  test("a PR outside the task's repository is named in full wherever the text is stored", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(6, { repository: "acme/other" })],
    });
    await c.add({ short_id: "ct-1", ref: "acme/other#6" });
    await c.movePr(6, { state: "merged" });
    expect((await c.read("task_history")).map((h) => h.new_value)).toEqual([
      "Waiting on PR acme/other#6",
      "PR acme/other#6 merged",
    ]);
    expect(await c.comments("ct-1")).toEqual([
      "note: Unblocked: PR acme/other#6 merged",
    ]);
  });

  test("a wait left untouched writes no history when the task's repositories change", async () => {
    const c = await setup({
      tasks: [task("ct-1", { conversation_ids: ["conv_x"] })],
      conversations: [
        {
          _id: "conv_x",
          user_id: USER,
          git_remote_url: "git@github.com:acme/app.git",
          updated_at: 1,
        },
      ],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: "#42" });
    // A second repository's session joins: a PR now reads as owner/repo#42.
    await c.t.run(({ db }) =>
      db.patch(Object.values(c.conversations)[0], {
        git_remote_url: "git@github.com:acme/other.git",
      }),
    );
    await c.add({ short_id: "ct-1", ref: "2h" });
    expect(
      (await c.read("task_history")).map((h) => [
        h.old_value,
        h.new_value.replace(/until .*/, "until T"),
      ]),
    ).toEqual([
      ["", "Waiting on PR #42"],
      ["", "Waiting until T"],
    ]);
  });

  test("create sets its waits in the same mutation: a refused one fails the create", async () => {
    const c = await setup({ pull_requests: [pr(42)] });
    const res = await c.create({
      title: "After the PR",
      waits: ["#42", "2h"],
      repository: REPO,
      time_zone: "UTC",
    });
    expect(res.waits.map((w: any) => [w.wait.kind, w.met])).toEqual([
      ["pr_merged", false],
      ["time", false],
    ]);
    expect((await c.row(res.short_id)).waits.map((w: any) => w.state)).toEqual([
      "waiting",
      "waiting",
    ]);
    expect((await c.row(res.short_id)).waiting_since).toBeNumber();
    await expect(
      c.create({ title: "Never clears", waits: [`${REPO}#7`] }),
    ).rejects.toThrow(/cannot see PR acme\/app#7/);
  });

  test("a PR closed without merging is refused: it would never clear", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42, { state: "closed" })],
    });
    await expect(
      c.add({ short_id: "ct-1", ref: `${REPO}#42` }),
    ).rejects.toThrow(/closed without merging/);
  });

  test("a bare #42 takes its repository from the task's sessions, else the caller's", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { conversation_ids: ["conv_x"], project_path: undefined }),
        task("ct-2", { project_path: undefined }),
      ],
      conversations: [
        {
          _id: "conv_x",
          user_id: USER,
          git_remote_url: "git@github.com:Acme/App.git",
          updated_at: 1,
        },
      ],
      pull_requests: [
        pr(42),
        pr(42, { _id: "pr_other", repository: "other/repo" }),
      ],
    });
    expect(
      (
        await c.add({
          short_id: "ct-1",
          ref: "#42",
          repository: "other/repo",
        })
      ).wait.repository,
    ).toBe(REPO);
    expect(
      (
        await c.add({
          short_id: "ct-2",
          ref: "#42",
          repository: "Other/Repo",
        })
      ).wait.repository,
    ).toBe("other/repo");
    await expect(c.add({ short_id: "ct-2", ref: "#43" })).rejects.toThrow(
      /names no repository/,
    );
    expect((await c.row("ct-2")).waits).toHaveLength(1);
  });

  test("a bare #42 with two candidate repositories names them", async () => {
    const c = await setup({
      tasks: [task("ct-1", { conversation_ids: ["conv_x", "conv_y"] })],
      conversations: [
        {
          _id: "conv_x",
          user_id: USER,
          git_remote_url: "https://github.com/acme/app",
          updated_at: 1,
        },
        {
          _id: "conv_y",
          user_id: USER,
          git_remote_url: "https://github.com/acme/web",
          updated_at: 1,
        },
      ],
      pull_requests: [
        pr(42),
        pr(42, { _id: "pr_web", repository: "acme/web" }),
        pr(9, { _id: "pr_9" }),
      ],
    });
    await expect(c.add({ short_id: "ct-1", ref: "#42" })).rejects.toThrow(
      "acme/app#42, acme/web#42",
    );
    // Only one of them has #9: that one.
    expect((await c.add({ short_id: "ct-1", ref: "#9" })).wait.repository).toBe(
      REPO,
    );
    // The caller's checkout settles it when it is one of them.
    expect(
      (
        await c.add({
          short_id: "ct-1",
          ref: "#42",
          repository: "Acme/Web",
        })
      ).wait.repository,
    ).toBe("acme/web");
  });

  test("the same target twice returns the wait already there", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    const first = await c.add({
      short_id: "ct-1",
      ref: `${REPO}#42`,
    });
    const again = await c.add({
      short_id: "ct-1",
      ref: `https://github.com/${REPO}/pull/42`,
    });
    expect(again).toMatchObject({
      existing: true,
      wait: { id: first.wait.id },
    });
    expect((await c.row("ct-1")).waits).toHaveLength(1);
  });

  test("the web's own wait id is kept, and a client target is rebuilt from its known fields", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      session_decisions: [decision(4)],
    });
    const res = await c.actor.mutation(api.dispatch.dispatch, {
      action: "addWait",
      args: [
        "ct-1",
        {
          id: "wmgh2k3l0a1",
          target: {
            kind: "decision",
            decision: "SD-4",
            state: "met",
            extra: 1,
          },
        },
      ],
    });
    expect(res.wait.id).toBe("wmgh2k3l0a1");
    expect((await c.row("ct-1")).waits[0]).toEqual({
      kind: "decision",
      decision: "sd-4",
      id: "wmgh2k3l0a1",
      state: "waiting",
      created_at: res.wait.created_at,
      created_by: c.user,
    });
    // A replay of the same write (the dispatch outbox retrying) adds nothing.
    expect(
      (
        await c.add({
          short_id: "ct-1",
          id: "wmgh2k3l0a1",
          target: { kind: "decision", decision: "sd-4" },
        })
      ).existing,
    ).toBe(true);
    await expect(
      c.add({ short_id: "ct-1", id: "bad id!", ref: "2h" }),
    ).rejects.toThrow(/wait id/);
    // Another client id on the same target is refused, so that client's draft rolls back.
    await expect(
      c.add({
        short_id: "ct-1",
        id: "wmgh2k3l0a2",
        target: { kind: "decision", decision: "sd-4" },
      }),
    ).rejects.toThrow(/already waiting on sd-4/);
    expect((await c.row("ct-1")).waits).toHaveLength(1);
  });

  test("removing by id again (the dispatch retrying) removes nothing and does not fail", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    const { wait } = await c.add({
      short_id: "ct-1",
      ref: `${REPO}#42`,
    });
    expect(
      (await c.remove({ short_id: "ct-1", wait_id: wait.id })).removed,
    ).toHaveLength(1);
    expect(
      (await c.remove({ short_id: "ct-1", wait_id: wait.id })).removed,
    ).toEqual([]);
    await expect(c.remove({ short_id: "ct-1", ref: "#42" })).rejects.toThrow(
      /has no wait on #42/,
    );
    expect((await c.row("ct-1")).waits).toEqual([]);
  });

  test("a task ref is refused: it is a dependency, not a wait", async () => {
    const c = await setup({ tasks: [task("ct-1")] });
    await expect(c.add({ short_id: "ct-1", ref: "ct-5" })).rejects.toThrow(
      /dependency/,
    );
  });

  test("removing a wait by ref clears waiting_since and writes history", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    const { removed } = await c.remove({
      short_id: "ct-1",
      ref: "#42",
    });
    expect(removed).toHaveLength(1);
    expect((await c.row("ct-1")).waits).toEqual([]);
    expect((await c.row("ct-1")).waiting_since).toBeUndefined();
    expect((await c.read("task_history")).at(-1)).toMatchObject({
      field: "waits",
      old_value: "Waiting on PR #42",
      new_value: "",
    });
  });
});
