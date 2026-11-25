import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { mountWeb } from "../../test-helpers/mountWeb";
import { button } from "../../test-helpers/composer-control-fixture";
import { ConversationTerminalSplit } from "./session-terminal";

const conversationId = "team-watch-conversation" as Id<"conversations">;
const share = "team-watch-grant" as Id<"terminal_watch_shares">;
const viewer = "team-watcher" as Id<"users">;
const conversationArgs = { conversation_id: conversationId };
const leaseArgs = { ...conversationArgs, share };
const apiWatch = api.terminalWatch;
const ownerStatus = { role: "owner", available: true, enabled: false } as const;

test("the owner confirms sharing, can stop a named viewer and can turn sharing off in one press", async () => {
  const { container, dom, backend } = await mountWeb(
    <ConversationTerminalSplit convKey={conversationId} teamTerminal />,
    {
      setup: (backend) => {
        backend.set(apiWatch.status, ownerStatus);
        backend.set(apiWatch.blockedViewers, []);
        backend.mutation(apiWatch.unblockViewer, true);
        backend.set(apiWatch.watchers, [
          { user_id: viewer, name: "Ana", expires_at: 1, remaining_ms: 50_000 },
        ]);
        backend.mutation(apiWatch.setSharing, true);
        backend.mutation(apiWatch.stopViewer, true);
      },
    },
  );
  expect(backend.queryRequests).toEqual([]);
  await act(async () => button(container, "Team terminal").click());
  await act(async () => button(container, "Share terminal…").click());
  expect(backend.mutations).toHaveLength(0);
  const dialog =
    dom.window.document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.textContent).toContain("Read-only");
  await act(async () =>
    dialog!
      .querySelector<HTMLButtonElement>('[title="Share terminal"]')!
      .click(),
  );
  expect(backend.mutations.map((call) => call.args)).toEqual([
    { ...conversationArgs, enabled: true },
  ]);

  await act(async () =>
    backend.set(apiWatch.status, { ...ownerStatus, enabled: true }),
  );
  expect(
    container.querySelector('[aria-label="Terminal viewers"]')?.textContent,
  ).toContain("Ana");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Stop Ana watching"]')!
      .click(),
  );
  await act(async () =>
    backend.set(apiWatch.blockedViewers, [{ user_id: viewer, name: "Ana" }]),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Unblock Ana"]')!
      .click(),
  );
  await act(async () => button(container, "Stop sharing terminal").click());
  expect(backend.mutations.map((call) => call.args)).toEqual([
    { ...conversationArgs, enabled: true },
    { ...conversationArgs, viewer },
    { ...conversationArgs, viewer },
    { ...conversationArgs, enabled: false },
  ]);
  expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
});

test("a teammate opens a screen-only pane and revocation clears it", async () => {
  const { container, dom, backend } = await mountWeb(
    <ConversationTerminalSplit convKey={conversationId} teamTerminal />,
    {
      setup: (backend) => {
        backend.set(apiWatch.status, { role: "viewer", share });
        backend.set(apiWatch.screen, {
          text: "redacted screen",
          revision: 1,
          stale_in_ms: 12_000,
          expires_in_ms: 50_000,
        });
        backend.mutation(apiWatch.watch, true);
        backend.mutation(apiWatch.leave, true);
      },
    },
  );
  expect(container.textContent).not.toContain("redacted screen");
  await act(async () => button(container, "Team terminal").click());
  await act(async () => button(container, "Watch terminal").click());
  const screen = container.querySelector(
    'pre[aria-label="Read-only terminal screen"]',
  );
  expect(screen?.textContent).toBe("redacted screen");
  expect(
    container.querySelector("input,textarea,[contenteditable],canvas"),
  ).toBeNull();
  await act(async () =>
    screen?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }),
    ),
  );
  expect(backend.mutations.map((call) => call.args)).toEqual([
    { ...leaseArgs, renew: false },
  ]);
  await act(async () =>
    backend.set(apiWatch.screen, {
      text: null,
      revision: 2,
      stale_in_ms: 12_000,
      expires_in_ms: 50_000,
    }),
  );
  expect(container.textContent).toContain("Terminal paused");
  await act(async () => backend.set(apiWatch.screen, null));
  expect(container.textContent).not.toContain("redacted screen");
  expect(container.textContent).toContain("Watch terminal");
  expect(backend.mutations.map((call) => call.args)).toEqual([
    { ...leaseArgs, renew: false },
    leaseArgs,
  ]);
  await act(async () => backend.set(apiWatch.status, null));
  expect(container.textContent).toContain("Terminal unavailable");
  await act(async () => button(container, "Hide team terminal").click());
  expect(container.textContent).toBe("Team terminal");
});

test("a failed terminal status query leaves the session surface in place", async () => {
  const { container } = await mountWeb(
    <>
      <span>Session transcript</span>
      <ConversationTerminalSplit convKey={conversationId} teamTerminal />
    </>,
    {
      setup: (backend) =>
        backend.set(apiWatch.status, new Error("Unavailable")),
    },
  );
  await act(async () => button(container, "Team terminal").click());
  expect(container.textContent).toContain("Session transcript");
  expect(container.textContent).toContain("Terminal unavailable");
});
