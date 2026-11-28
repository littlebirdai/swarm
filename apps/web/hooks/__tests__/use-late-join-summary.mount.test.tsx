import { expect, spyOn, test } from "bun:test";
import { act, Profiler, StrictMode } from "react";
import { ConvexProviderWithAuth, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { getFunctionName } from "convex/server";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import {
  useLateJoinSummary,
  type LateJoinSummary,
} from "../use-late-join-summary";

const conversationId = "j".repeat(32) as Id<"conversations">;
const anchorMsgId = "m".repeat(32) as Id<"messages">;
const decisionId = "d".repeat(32) as Id<"session_decisions">;

const populatedSummary: LateJoinSummary = {
  anchor: {
    message_id: anchorMsgId,
    offset: 0.2,
    timestamp: 1_000,
    changed_at: 1_500,
  },
  new_turns: 3,
  turns_truncated: false,
  changed_files: [
    { path: "apps/web/components/conversation-view.tsx", count: 2 },
    { path: "apps/server/convex/lateJoinSummary.ts", count: 1 },
  ],
  changed_files_total: 2,
  changed_files_truncated: false,
  decisions: [
    {
      _id: decisionId,
      short_id: "sd-42",
      title: "Keep summary behind flag?",
      state: "pending",
    },
  ],
  decisions_total: 1,
  decisions_truncated: false,
  can_open_decisions: true,
  open_prompt: {
    kind: "permission",
    source: "pending_permission",
    label: "Run unit tests",
    tool_name: "Bash",
    created_at: 5_000,
  },
};

function HookProbe({
  convId,
  enabled,
}: {
  convId: Id<"conversations">;
  enabled: boolean;
}) {
  const summary = useLateJoinSummary(convId, enabled);
  return (
    <div data-cc-hook-probe>
      {summary ? summary.anchor.message_id : summary === null ? "null" : "wait"}
    </div>
  );
}

function countLateJoinQueries(spy: ReturnType<typeof spyOn>) {
  return spy.mock.calls.filter(
    (call: unknown[]) =>
      getFunctionName(call[0] as any) === "lateJoinSummary:get",
  ).length;
}

test("survives StrictMode double mount, enabled flicker, aborts cleanly on disable or unmount, and retries once", async () => {
  let querySpy!: ReturnType<typeof spyOn>;

  const strictUi = await mountWeb(
    <StrictMode>
      <HookProbe convId={conversationId} enabled />
    </StrictMode>,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        querySpy = spyOn(backend.client, "query");
        backend.set(api.lateJoinSummary.get, pending);
      },
    },
  );
  expect(countLateJoinQueries(querySpy)).toBe(1);

  await strictUi.rerender(
    <StrictMode>
      <HookProbe convId={conversationId} enabled={false} />
    </StrictMode>,
  );
  await strictUi.rerender(
    <StrictMode>
      <HookProbe convId={conversationId} enabled />
    </StrictMode>,
  );
  expect(countLateJoinQueries(querySpy)).toBe(1);

  await act(async () => {
    strictUi.backend.set(api.lateJoinSummary.get, populatedSummary);
  });
  expect(
    strictUi.container.querySelector("[data-cc-hook-probe]")?.textContent,
  ).toBe(anchorMsgId);
  await strictUi.close();

  let abortSettleRenders = 0;
  let abortSettleSpy!: ReturnType<typeof spyOn>;
  const abortSettleUi = await mountWeb(
    <Profiler
      id="abort-settle"
      onRender={() => {
        abortSettleRenders += 1;
      }}
    >
      <HookProbe convId={conversationId} enabled />
    </Profiler>,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        abortSettleSpy = spyOn(backend.client, "query");
        backend.set(api.lateJoinSummary.get, pending);
      },
    },
  );
  await abortSettleUi.rerender(
    <Profiler
      id="abort-settle"
      onRender={() => {
        abortSettleRenders += 1;
      }}
    >
      <HookProbe convId={conversationId} enabled={false} />
    </Profiler>,
  );
  const rendersAfterDisable = abortSettleRenders;
  await act(async () => {
    abortSettleUi.backend.set(api.lateJoinSummary.get, populatedSummary);
  });
  expect(abortSettleRenders).toBe(rendersAfterDisable);
  await abortSettleUi.rerender(
    <Profiler
      id="abort-settle"
      onRender={() => {
        abortSettleRenders += 1;
      }}
    >
      <HookProbe convId={conversationId} enabled />
    </Profiler>,
  );
  expect(countLateJoinQueries(abortSettleSpy)).toBe(2);
  expect(
    abortSettleUi.container.querySelector("[data-cc-hook-probe]")?.textContent,
  ).toBe(anchorMsgId);
  await abortSettleUi.close();

  let abortRejectRenders = 0;
  let abortRejectSpy!: ReturnType<typeof spyOn>;
  const abortRejectUi = await mountWeb(
    <Profiler
      id="abort-reject"
      onRender={() => {
        abortRejectRenders += 1;
      }}
    >
      <HookProbe convId={conversationId} enabled />
    </Profiler>,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        abortRejectSpy = spyOn(backend.client, "query");
        backend.set(api.lateJoinSummary.get, pending);
      },
    },
  );
  await abortRejectUi.rerender(
    <Profiler
      id="abort-reject"
      onRender={() => {
        abortRejectRenders += 1;
      }}
    >
      <HookProbe convId={conversationId} enabled={false} />
    </Profiler>,
  );
  const rendersBeforeReject = abortRejectRenders;
  await act(async () => {
    abortRejectUi.backend.set(
      api.lateJoinSummary.get,
      () => new Error("late rejection"),
    );
  });
  expect(abortRejectRenders).toBe(rendersBeforeReject);
  expect(countLateJoinQueries(abortRejectSpy)).toBe(1);
  await abortRejectUi.close();

  let attempt = 0;
  const retryUi = await mountWeb(
    <HookProbe convId={conversationId} enabled />,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(api.lateJoinSummary.get, () => {
          attempt += 1;
          if (attempt === 1) return new Error("transient outage");
          return populatedSummary;
        });
      },
    },
  );
  expect(
    retryUi.backend.queryRequests.filter(
      (q) => q.name === "lateJoinSummary:get",
    ),
  ).toHaveLength(2);
  expect(
    retryUi.container.querySelector("[data-cc-hook-probe]")?.textContent,
  ).toBe(anchorMsgId);
  await retryUi.close();

  const failUi = await mountWeb(<HookProbe convId={conversationId} enabled />, {
    authenticated: true,
    dispatch: true,
    setup(backend) {
      backend.set(
        api.lateJoinSummary.get,
        () => new Error("persistent outage"),
      );
    },
  });
  expect(
    failUi.backend.queryRequests.filter(
      (q) => q.name === "lateJoinSummary:get",
    ),
  ).toHaveLength(2);
  expect(
    failUi.container.querySelector("[data-cc-hook-probe]")?.textContent,
  ).toBe("wait");
  await failUi.close();

  function UnconfirmedAuth() {
    const client = useConvex();
    return (
      <ConvexProviderWithAuth
        client={client}
        useAuth={() => ({
          isLoading: true,
          isAuthenticated: false,
          fetchAccessToken: async () => null,
        })}
      >
        <HookProbe convId={conversationId} enabled />
      </ConvexProviderWithAuth>
    );
  }
  const unauthUi = await mountWeb(<UnconfirmedAuth />, {
    dispatch: true,
    setup(backend) {
      backend.set(api.lateJoinSummary.get, populatedSummary);
    },
  });
  expect(
    unauthUi.backend.queryRequests.filter(
      (q) => q.name === "lateJoinSummary:get",
    ),
  ).toEqual([]);
  await unauthUi.close();
});
