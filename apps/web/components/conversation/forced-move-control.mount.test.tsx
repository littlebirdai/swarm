import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { tickCoarseClocks } from "../../hooks/useCoarseNow";
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
const destinations = [
  { id: "studio", label: "Studio" },
  { id: "team-mac", label: "Team Mac" },
];

function moveOptions(conversationId: Id<"conversations">) {
  return {
    _id: conversationId,
    epoch: 7,
    sourceLabel: "Laptop",
    offlineAfter: 0,
    requestedDestination: null as string | null,
    progress: null,
    failure: null,
    destinations,
  };
}

afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

async function mount(
  outcome:
    | "off"
    | "accepted"
    | "refused"
    | "structured"
    | "online"
    | "transient",
) {
  const refused = outcome === "refused" || outcome === "structured";
  if (outcome === "off") delete process.env[flag];
  else process.env[flag] = "1";
  const conversationId = builders.session.build()._id as Id<"conversations">;
  const calls: unknown[][] = [];
  const ui = await mountWeb(
    <DeviceMoveStatusStrip conversationId={conversationId} />,
    {
      authenticated: true,
      dispatch: true,
      clock: outcome === "transient",
      expectedConsoleErrors:
        refused || outcome === "transient"
          ? [
              ...Array.from(
                { length: refused ? 1 : 4 },
                () => /\[CONVEX M\(dispatch:dispatch\)\].*/,
              ),
              /\[sync\] dispatch failed after retries: forceSessionMove/,
            ]
          : undefined,
      setup(backend) {
        if (outcome !== "off") {
          backend.set(api.edgeRunLease.forcedMoveOptions, [
            {
              ...moveOptions(conversationId),
              offlineAfter: outcome === "online" ? Date.now() + 600_000 : 0,
            },
          ]);
        }
        backend.mutation(api.dispatch.dispatch, ({ action, args }) => {
          if (action !== "forceSessionMove") throw new Error(action);
          calls.push(args);
          if (outcome === "transient") return new Error("Try again later");
          if (!refused) return "move-id";
          const data =
            outcome === "structured"
              ? { code: "STALE_EPOCH", message: refusal }
              : refusal;
          const error = new ConvexError(data);
          error.message = `[Request ID: fake] Server Error\nUncaught ConvexError: ${JSON.stringify(data)}`;
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

async function chooseDestination(
  container: HTMLElement,
  action = "Move to another device",
) {
  await act(async () => button(container, action).click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const select = dialog.querySelector("select")!;
  expect(
    dialog.querySelector<HTMLButtonElement>("[data-switch-confirm]")?.disabled,
  ).toBe(true);
  expect([...select.options].map((o) => o.textContent)).toEqual([
    "Choose a device",
    "Studio",
    "Team Mac",
  ]);
  await act(async () => {
    select.value = "team-mac";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(button(dialog, "Force move").disabled).toBe(false);
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
  await act(async () => flushSyncPublishes());
  expect(ui.container.querySelector('[role="status"]')?.textContent).toBe(
    "Move to Team Mac requested",
  );
  expect(ui.container.querySelector("button")).toBeNull();
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

async function refuseMove(ui: Awaited<ReturnType<typeof mount>>) {
  const dialog = await chooseDestination(ui.container);
  await act(async () => button(dialog, "Force move").click());
  expect(ui.calls).toHaveLength(1);
  await act(async () => flushSyncPublishes());
}

test.each(["refused", "structured"] as const)(
  "a %s server error appears as the exact refusal message",
  async (outcome) => {
    const ui = await mount(outcome);
    await refuseMove(ui);
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe(
      refusal,
    );
    expect(button(ui.container, "Move to another device").disabled).toBe(false);
  },
);

test("a destination-only push refreshes the choices and an empty list hides the action", async () => {
  const ui = await mount("accepted");
  const options = moveOptions(ui.conversationId);
  await act(async () => {
    ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
      { ...options, destinations: [{ id: "new", label: "New computer" }] },
    ]);
    flushSyncPublishes();
  });
  await act(async () => button(ui.container, "Move to another device").click());
  const strip = button(ui.container, "Move to another device").parentElement!;
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(
    [...dialog.querySelectorAll("option")].map((option) => option.value),
  ).toEqual(["", "new"]);
  await act(async () => button(dialog, "Cancel").click());
  await act(async () => {
    ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
      { ...options, destinations: [] },
    ]);
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("");
  expect(ui.container.contains(strip)).toBe(false);
});

test.each(["dismissed", "new epoch", "source online", "flag off"] as const)(
  "the refusal disappears when %s",
  async (cause) => {
    const ui = await mount("refused");
    await refuseMove(ui);
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe(
      refusal,
    );
    if (cause === "dismissed")
      await act(async () => button(ui.container, "Dismiss").click());
    else if (cause === "flag off") {
      delete process.env[flag];
      await ui.rerender(
        <DeviceMoveStatusStrip
          key="flag changed"
          conversationId={ui.conversationId}
        />,
      );
    } else {
      const options = moveOptions(ui.conversationId);
      await act(async () => {
        ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
          cause === "new epoch"
            ? { ...options, epoch: options.epoch + 1 }
            : { ...options, offlineAfter: Date.now() + 600_000 },
        ]);
        flushSyncPublishes();
      });
    }
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
  },
);

test("a transient dispatch failure leaves the request pending", async () => {
  const ui = await mount("transient");
  const dialog = await chooseDestination(ui.container);
  await act(async () => button(dialog, "Force move").click());
  for (const delay of [1000, 2000, 4000]) await ui.clock!.advance(delay);
  await act(async () => flushSyncPublishes());
  expect(ui.calls).toHaveLength(4);
  expect(ui.container.querySelector('[role="alert"]')).toBeNull();
  expect(button(ui.container, "Requesting move").disabled).toBe(true);
});

test("the status strip follows the scheduler's progress and failure", async () => {
  const ui = await mount("accepted");
  for (const [progress, label, failure, role] of [
    ["preparing", "Preparing Team Mac", null, "status"],
    ["moving", "Moving session to Team Mac", null, "status"],
    [
      "failed",
      "Move to Team Mac failed",
      "The destination daemon did not connect",
      "alert",
    ],
    ["done", "Session moved to Team Mac", null, "status"],
  ] as const) {
    await act(async () => {
      ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
        {
          ...moveOptions(ui.conversationId),
          requestedDestination: "Team Mac",
          progress,
          failure,
          destinations: [],
        },
      ]);
      flushSyncPublishes();
    });
    const status = ui.container.querySelector(`[role="${role}"]`);
    expect(status?.textContent).toContain(label);
    if (failure) expect(status?.textContent).toContain(failure);
  }
  expect(ui.calls).toEqual([]);
});

test("a failed move lets the owner choose a computer and confirm again", async () => {
  const ui = await mount("accepted");
  await act(async () => {
    ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
      {
        _id: ui.conversationId,
        epoch: 7,
        sourceLabel: "Laptop",
        offlineAfter: Date.now() + 600_000,
        requestedDestination: "Studio",
        progress: "failed",
        failedMove: { move_id: "failed-move", revision: 10 },
        failure: "The destination daemon did not connect",
        destinations: [
          { id: "studio", label: "Studio" },
          { id: "team-mac", label: "Team Mac" },
        ],
      },
    ]);
    flushSyncPublishes();
  });
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain(
    "Move to Studio failed",
  );
  expect(ui.calls).toEqual([]);
  const dialog = await chooseDestination(ui.container, "Choose a computer");
  await act(async () => button(dialog, "Force move").click());
  expect(ui.calls).toEqual([
    [
      expect.any(String),
      ui.conversationId,
      7,
      "team-mac",
      "Team Mac",
      true,
      { move_id: "failed-move", revision: 10 },
    ],
  ]);
});

test("an expired receipt gives way to the offline move action without a new server result", async () => {
  const ui = await mount("accepted");
  await act(async () => {
    ui.backend.set(api.edgeRunLease.forcedMoveOptions, [
      {
        _id: ui.conversationId,
        epoch: 8,
        sourceLabel: "Studio",
        offlineAfter: 0,
        requestedDestination: "Studio",
        progress: "done",
        doneUntil: Date.now() - 1,
        failure: null,
        destinations: [{ id: "team-mac", label: "Team Mac" }],
      },
    ]);
    tickCoarseClocks();
    flushSyncPublishes();
  });
  expect(ui.container.textContent).not.toContain("Session moved");
  expect(button(ui.container, "Move to another device").disabled).toBe(false);
});
