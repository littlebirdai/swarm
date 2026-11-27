import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { act } from "react";
import { useLiveComposerControl } from "../../hooks/use-live-composer-control";
import { useInboxStore } from "../../store/inboxStore";
import type { SteerClaimState } from "../../store/steer-composer-state";
import {
  button,
  collaborator,
  createComposerMount,
  owner,
} from "../../test-helpers/composer-control-fixture";
import { mountWeb } from "../../test-helpers/mountWeb";

const mount = createComposerMount(mountWeb);
let nextId = 0;
function claimState(): SteerClaimState {
  const _id = (++nextId).toString().padStart(32, "a") as Id<"conversations">;
  const viewer = "b".repeat(32) as Id<"users">;
  return {
    _id,
    viewer,
    owner: true,
    turn: { id: "turn", run: 1, start_event_seq: 10 },
    holder: { id: viewer, name: "Owner" },
    baton_token: 1,
    delivery: null,
    takeover_pending: false,
    fence_id: null,
    can_take_over: true,
    can_send: true,
    can_steer: true,
    drive_requested: false,
    fresh_for_ms: 30000,
    queue: { items: [], more: false },
  };
}
const driver = { id: "c".repeat(32) as Id<"users">, name: "Ana" };

function Composer({
  row,
  enabled = true,
}: {
  row: SteerClaimState;
  enabled?: boolean;
}) {
  const control = useLiveComposerControl(row._id, row.viewer, enabled);
  return row.owner || !control
    ? owner(row._id, control)
    : collaborator(row._id, control);
}

function show(row: SteerClaimState, status = "acknowledged", enabled = true) {
  return mount(<Composer row={row} enabled={enabled} />, {
    setup(backend) {
      backend.set(api.collab.steerClaimState, row);
      backend.set(api.collab.mySendAccess, { level: "shared" });
      backend.mutation(api.dispatch.dispatch, { status });
    },
  });
}

test("the disabled composer skips the feed and keeps the existing editor", async () => {
  const row = claimState();
  const ui = await show(row, "acknowledged", false);
  expect(
    ui.container.querySelector('[aria-label="Session control"]'),
  ).toBeNull();
  expect(
    ui.backend.queryRequests.some(
      ({ name }) => name === "collab:steerClaimState",
    ),
  ).toBe(false);
  expect(ui.box()).toBeTruthy();
});

test("the store-backed Send action sends the observed instance and shows Saved", async () => {
  const row = claimState();
  const ui = await show(row);
  expect(useInboxStore.getState().fencedSteerClaims[row._id]).toMatchObject({
    holder: row.holder,
  });
  expect(ui.container.textContent).toContain("Driving · You");
  await ui.type("Steer this turn");
  await ui.press("Enter");
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [
      row._id,
      { kind: "send", text: "Steer this turn", observed: row.turn },
    ],
  });
  expect(ui.container.textContent).toContain("Saved");
});

test("another driver makes Enter queue and live delivery states follow the store", async () => {
  const row = { ...claimState(), holder: driver, can_steer: false };
  const ui = await show(row);
  expect(ui.container.textContent).toContain("Driving · Ana");
  await ui.type("Queue this");
  await act(() => button(ui.container, "Queue").click());
  const sent = ui.backend.mutations.at(-1)?.args as {
    args: [string, Record<string, unknown>];
  };
  expect(sent.args[1]).toMatchObject({ kind: "send", text: "Queue this" });
  expect(sent.args[1]).not.toHaveProperty("observed");
  for (const [delivery, text] of [
    ["delivery-started", "With the agent"],
    ["ambiguous", "Delivery in doubt"],
  ] as const) {
    await act(() =>
      ui.backend.set(api.collab.steerClaimState, { ...row, delivery }),
    );
    expect(ui.container.textContent).toContain(text);
  }
  await act(() => ui.backend.set(api.collab.steerClaimState, null));
  expect(useInboxStore.getState().fencedSteerClaims[row._id]).toBeUndefined();
  expect(
    ui.container.querySelector('[aria-label="Session control"]'),
  ).toBeNull();
});

test("a viewer asks to drive through the store and sees the pending grant", async () => {
  const row = {
    ...claimState(),
    owner: false,
    holder: driver,
    can_send: false,
    can_steer: false,
    can_take_over: false,
  };
  const ui = await show(row, "requested");
  await act(() => button(ui.container, "Ask to drive").click());
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [row._id, { kind: "ask" }],
  });
  await act(() =>
    ui.backend.set(api.collab.steerClaimState, {
      ...row,
      drive_requested: true,
    }),
  );
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
});

test("takeover requires confirmation for the exact instance and cancel passes the fence id", async () => {
  const row = { ...claimState(), holder: driver, can_steer: false };
  const ui = await show(row, "pending");
  await act(() => button(ui.container, "Take over").click());
  expect(ui.backend.mutations).toHaveLength(0);
  const confirm = ui.dom.window.document.querySelector<HTMLButtonElement>(
    "[data-switch-confirm]",
  )!;
  await act(() => confirm.click());
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [
      row._id,
      {
        kind: "takeover",
        holder: driver.id,
        token: row.baton_token,
        expected: row.turn,
      },
    ],
  });
  await act(() =>
    ui.backend.set(api.collab.steerClaimState, {
      ...row,
      takeover_pending: true,
      fence_id: "fence",
    }),
  );
  expect(ui.container.textContent).toContain("Waiting for the machine");
  await act(() => button(ui.container, "Cancel takeover").click());
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [row._id, { kind: "cancel", fenceId: "fence" }],
  });
});

test("an issued takeover fence keeps the waiting status without a cancel button", async () => {
  const ui = await show({
    ...claimState(),
    holder: driver,
    can_steer: false,
    takeover_pending: true,
    fence_id: null,
  });
  expect(ui.container.textContent).toContain("Waiting for the machine");
  expect(ui.container.textContent).not.toContain("Cancel takeover");
  expect(ui.container.textContent).not.toContain("Take over");
});

test("a stale send restores the draft and offers Queue", async () => {
  const row = claimState();
  const ui = await show(row, "stale");
  await ui.type("Keep this draft");
  await ui.press("Enter");
  expect(ui.box().value).toBe("Keep this draft");
  expect(ui.container.textContent).toContain("Turn ended");
  expect(button(ui.container, "Queue")).toBeTruthy();
});
