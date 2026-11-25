import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { WorkflowRunNodes } from "../WorkflowRunNodes";
import { TooltipProvider } from "../ui/tooltip";

const CONV_ID = "kc1abcdefabcdefabcdefabcdefabcde";
const now = 1_800_000_000_000;

const run = {
  _id: "kw1abcdefabcdefabcdefabcdefabcde",
  status: "running",
  current_node_id: "web-client",
  node_statuses: [
    {
      node_id: "protocol-package",
      status: "completed",
      outcome: "success",
      started_at: now - 600_000,
      completed_at: now - 300_000,
      session: {
        _id: CONV_ID,
        session_id: "sess-protocol",
        title: "Define the wire protocol",
        message_count: 42,
        is_active: false,
        updated_at: now - 300_000,
        agent_type: "claude_code",
      },
    },
    {
      node_id: "integrate-deploy",
      status: "failed",
      session_id: "sess-deploy",
      started_at: now - 200_000,
      completed_at: now - 100_000,
    },
    {
      node_id: "web-client",
      status: "running",
      activity: "Editing apps/web/app/page.tsx",
    },
    { node_id: "independent-verify", status: "pending" },
  ],
};

const workflow = {
  _id: "kf1abcdefabcdefabcdefabcdefabcde",
  name: "desiredb-build",
  nodes: [
    { id: "start", label: "start", type: "start" },
    { id: "protocol-package", label: "protocol-package", type: "agent" },
    { id: "integrate-deploy", label: "integrate-deploy", type: "agent" },
    { id: "web-client", label: "web-client", type: "agent" },
    { id: "independent-verify", label: "independent-verify", type: "command" },
    { id: "exit", label: "exit", type: "exit" },
  ],
};

const mount = (props: ComponentProps<typeof WorkflowRunNodes>) =>
  mountWeb(
    <TooltipProvider>
      <WorkflowRunNodes {...props} />
    </TooltipProvider>,
  );

describe("WorkflowRunNodes", () => {
  test("a completed node with a session is a session row that links to its conversation", async () => {
    const { container, navigationLog } = await mount({ run, workflow });
    const row = container.querySelector(`[data-session-id="${CONV_ID}"]`)!;
    expect(row).not.toBeNull();
    expect(
      row.querySelector(`a[href="/conversation/${CONV_ID}"]`),
    ).not.toBeNull();
    expect(row.textContent).toContain("Define the wire protocol");
    expect(row.textContent).toContain("protocol-package");
    expect(row.textContent).toContain("42 msgs");
    expect(row.querySelector('[data-step-status="completed"]')).not.toBeNull();
    await act(() => row.querySelector<HTMLAnchorElement>("a")!.click());
    expect(navigationLog.at(-1)).toEqual({
      action: "push",
      path: `/conversation/${CONV_ID}`,
    });
  });

  test("a node with only a daemon handle still opens by that handle", async () => {
    const { container } = await mount({ run, workflow });
    const row = container.querySelector('[data-step="integrate-deploy"]')!;
    expect(
      row.querySelector('a[href="/conversation/sess-deploy"]'),
    ).not.toBeNull();
    expect(row.querySelector('[data-step-status="failed"]')).not.toBeNull();
  });

  test("the current node shows what it is doing; a pending node is a plain step", async () => {
    const { container } = await mount({ run, workflow });
    const current = container.querySelector('[data-step="web-client"]')!;
    expect(current.textContent).toContain("Editing apps/web/app/page.tsx");
    expect(
      current.querySelector('[data-step-status="running"]'),
    ).not.toBeNull();
    const pending = container.querySelector(
      '[data-step="independent-verify"]',
    )!;
    expect(pending.querySelector("a")).toBeNull();
    expect(container.querySelector('[data-step="start"]')).toBeNull();
    expect(container.querySelector('[data-step="exit"]')).toBeNull();
  });

  test("a dynamic run groups its agents under the phases it declared", async () => {
    const dynamic = {
      _id: "kw2abcdefabcdefabcdefabcdefabcde",
      status: "completed",
      run_kind: "workflow",
      phases: [{ title: "Review" }, { title: "Verify" }],
      node_statuses: [
        {
          node_id: "a1",
          status: "completed",
          label: "review:bugs",
          phase: "Review",
          tokens: 12_400,
          result_preview: "3 findings",
        },
        {
          node_id: "a2",
          status: "completed",
          label: "verify:bugs",
          phase: "Verify",
          tokens: 800,
        },
      ],
    };
    const { container } = await mount({ run: dynamic });
    const text = container.textContent ?? "";
    expect(text.indexOf("Review")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Review")).toBeLessThan(text.indexOf("Verify"));
    expect(text).toContain("3 findings");
    expect(text).toContain("12k tok");
  });
});
