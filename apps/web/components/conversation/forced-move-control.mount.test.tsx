import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ConvexError } from "convex/values";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { DeviceMoveStatusStrip } from "./sessionChrome";

const flag = "VITE_CODECAST_FORCED_DEVICE_MOVE_V1";
const previous = process.env[flag];
const builders = webBuilders("forced-move-control.mount.test.tsx");
const refusal = "The source epoch changed before the forced move";

afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

async function mount(outcome: "off" | "accepted" | "refused" | "online") {
  if (outcome === "off") delete process.env[flag];
  else process.env[flag] = "1";
  const conversationId = builders.session.build()._id as Id<"conversations">;
  const calls: unknown[][] = [];
  const ui = await mountWeb(
    <DeviceMoveStatusStrip conversationId={conversationId} />,
    {
      authenticated: true,
      dispatch: true,
      expectedConsoleErrors:
        outcome === "refused"
          ? [
              /\[CONVEX M\(dispatch:dispatch\)\].*/,
              /\[sync\] dispatch failed after retries: forceSessionMove/,
            ]
          : undefined,
      setup(backend) {
        if (outcome !== "off") {
          backend.set(api.edgeRunLease.forcedMoveOptions, [
            {
              _id: conversationId,
              epoch: 7,
              sourceLabel: "Laptop",
              offlineAfter: outcome === "online" ? Date.now() + 600_000 : 0,
              requestedDestination: null,
              destinations: [
                { id: "studio", label: "Studio" },
                { id: "team-mac", label: "Team Mac" },
              ],
            },
          ]);
        }
        backend.mutation(api.dispatch.dispatch, ({ action, args }) => {
          if (action !== "forceSessionMove") throw new Error(action);
          calls.push(args);
          if (outcome !== "refused") return "move-id";
          const error = new ConvexError(refusal);
          error.message = `[Request ID: fake] Server Error\nUncaught ConvexError: "${refusal}"`;
          return error;
        });
      },
    },
  );
  return { ...ui, conversationId, calls };
}

function button(root: ParentNode, name: string) {
  const match = [...root.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name ||
      b.textContent?.trim().startsWith(name),
  );
  if (!match) throw new Error(`Missing button ${name}`);
  return match;
}

async function chooseDestination(container: HTMLElement) {
  await act(async () => button(container, "Move to another device").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const select = dialog.querySelector("select")!;
  expect([...select.options].map((o) => o.textContent)).toEqual([
    "Choose a device",
    "Studio",
    "Team Mac",
  ]);
  await act(async () => {
    select.value = "team-mac";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return dialog;
}

test.each(["off", "online"] as const)(
  "force move is hidden when the feature is %s",
  async (outcome) => {
    const ui = await mount(outcome);
    expect(ui.container.textContent).toBe("");
    expect(ui.calls).toEqual([]);
  },
);

test("the review shows the selected device and permanent consequences, and cancel sends nothing", async () => {
  const ui = await mount("accepted");
  const dialog = await chooseDestination(ui.container);
  expect(dialog.textContent).toContain("Team Mac");
  expect(dialog.textContent).toContain("Permanently cut off from this session");
  expect(dialog.textContent).toContain("May be lost on the old computer");
  expect(dialog.textContent).toContain("Delivery becomes uncertain");
  expect(dialog.textContent).toContain("This cannot be undone");
  expect(ui.calls).toEqual([]);
  await act(async () => button(dialog, "Cancel").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(ui.calls).toEqual([]);
});

test("deliberate confirm dispatches the selected move once and paints the request from the store", async () => {
  const ui = await mount("accepted");
  const dialog = await chooseDestination(ui.container);
  const confirm = button(dialog, "Force move");
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(ui.calls).toEqual([
    [expect.any(String), ui.conversationId, 7, "team-mac", "Team Mac", true],
  ]);
  await act(async () => {
    ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
      {
        _id: ui.conversationId,
        epoch: 7,
        sourceLabel: "Laptop",
        offlineAfter: 0,
        requestedDestination: "Team Mac",
        destinations: [],
      },
    ]);
    flushSyncPublishes();
  });
  expect(ui.container.querySelector('[role="status"]')?.textContent).toBe(
    "Move to Team Mac requested",
  );
});

test("a server refusal appears beside the move action", async () => {
  const ui = await mount("refused");
  const dialog = await chooseDestination(ui.container);
  await act(async () => button(dialog, "Force move").click());
  expect(ui.calls).toHaveLength(1);
  await act(async () => flushSyncPublishes());
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain(
    refusal,
  );
  expect(button(ui.container, "Move to another device").disabled).toBe(false);
});
