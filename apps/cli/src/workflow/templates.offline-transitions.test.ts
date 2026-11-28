import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
import { createOfflineLineFixture, offlineLine } from "./offline-line-fixture";
import { runWorkflow } from "./runner";

isolateCodecastDirEachTest("cast-wf-offline-transitions-");

describe("line.cast offline run task transitions", () => {
  let fx: ReturnType<typeof createOfflineLineFixture>;

  beforeEach(() => {
    fx = createOfflineLineFixture();
  });

  afterEach(() => {
    fx.restore();
  });

  test("a hand that goes quiet without settling fails its node, which ends the hand, and the task returns to open", async () => {
    const settle = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/cli/inbox")) {
        fx.calls.push({ route: "/cli/inbox", body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({
            sessions: [{ id: "conv_1", work_state: "idle", is_live: true }],
          }),
          { status: 200 },
        );
      }
      return settle(url, init);
    }) as typeof fetch;
    const outcome = await runWorkflow(
      offlineLine(fx.tmpDir),
      fx.opts({ agentTimeout: 30, runId: "run_1" }),
    );
    expect(outcome).toBe("failed");
    expect(
      fx.calls.some(
        (c) =>
          c.route === "/cli/workflow-runs/progress" &&
          c.body.node_status === "failed" &&
          c.body.session_id === "s1",
      ),
    ).toBe(true);
    expect(
      fx.calls.find((c) => c.route === "/cli/workflow-runs/task-transition")
        ?.body,
    ).toMatchObject({ run_id: "run_1", short_id: "ct-7", status: "open" });
    expect(
      fx.calls.find((c) => c.route === "/cli/work/comment")?.body.text,
    ).toContain("showed no work");
    expect(fx.calls.filter((c) => c.route === "/cli/spawn")).toHaveLength(1);
  }, 30000);

  for (const status of ["needs_context", "blocked"] as const) {
    test(`a ${status} handoff stops the run with the builder's words and asks nobody`, async () => {
      fx.effects.implement = () => {
        fx.setTask({
          ...fx.getTask(),
          status: "in_review",
          execution_status: status,
          verification_evidence:
            "The fix needs the release branch, which this checkout does not have.",
        });
      };
      const outcome = await runWorkflow(
        offlineLine(fx.tmpDir),
        fx.opts({ runId: "run_1", spawnerSession: "owner-sess" }),
      );
      expect(outcome).toBe("failed");
      expect(fx.stations()).toEqual([
        "ground",
        "analyze",
        "prove",
        "implement",
      ]);
      expect(fx.calls.some((c) => c.route === "/cli/workflow-runs/gate")).toBe(
        false,
      );
      expect(fx.calls.some((c) => c.route === "/cli/decide")).toBe(false);
      expect(
        fx.calls
          .filter((c) => c.route === "/cli/workflow-runs/task-transition")
          .at(-1)?.body,
      ).toMatchObject({ run_id: "run_1", short_id: "ct-7", status: "open" });
      const blocker = fx.calls.find(
        (c) =>
          c.route === "/cli/work/comment" && c.body.comment_type === "blocker",
      )?.body.text;
      expect(blocker).toBe(
        "Stopped: The fix needs the release branch, which this checkout does not have.\n\nFull output: https://codecast.sh/workflows/runs/run_1",
      );
      const ended = fx.calls
        .filter(
          (c) =>
            c.route === "/cli/workflow-runs/progress" &&
            c.body.run_status === "failed",
        )
        .at(-1)?.body;
      expect(
        `${ended?.fail_reason}\n\nFull output: https://codecast.sh/workflows/runs/run_1`,
      ).toBe(blocker!);
    }, 30000);
  }
});
