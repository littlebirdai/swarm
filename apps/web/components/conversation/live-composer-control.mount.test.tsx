import { installSignedInPrincipal } from "../../store/__tests__/fixtures/signedInPrincipal";
import {
  AUTH_JWT_STORAGE_KEY,
  issueFakeToken,
} from "../../store/__tests__/fixtures/fakeAuthToken";
import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { act, useLayoutEffect } from "react";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { _reopenForTests } from "../../store/idb-cache";
import { db } from "../../store/persistence/db";
import { setHydrating } from "../../store/persistence/hydration";
import { COMPOSER_RETRY_PREFIX } from "../../store/persistence/composer-retry-journal";
import { replicationPersistence } from "../../store/storage-transport";
import type { OutboxEntry } from "@platform/engine";
import { CollabRequestBanner } from "../collab-composer";
import {
  SteerClaimFeeder,
  useLiveComposerControl,
} from "../../hooks/use-live-composer-control";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { type SteerClaimState } from "../../store/steer-composer-state";
import {
  button,
  collaborator,
  createComposerMount,
  owner,
} from "../../test-helpers/composer-control-fixture";
import { replaceGlobals } from "../../test-helpers/globals";
import { mountWeb } from "../../test-helpers/mountWeb";

const mount = createComposerMount(mountWeb);
const signedInViewer = "b".repeat(32) as Id<"users">;
installSignedInPrincipal(signedInViewer);
const principalStorage = localStorage;
await _reopenForTests({ indexedDB, IDBKeyRange });

async function settleRecoveryWrites() {
  await act(async () => {
    await db.meta.count();
    await db.meta.count();
  });
}

let nextId = 0;
function claimState(): SteerClaimState {
  const _id = (++nextId).toString().padStart(32, "a") as Id<"conversations">;
  const viewer = signedInViewer;
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
  useLayoutEffect(
    () =>
      replaceGlobals({
        dispatchEvent: window.dispatchEvent.bind(window),
      }),
    [],
  );
  const control = useLiveComposerControl(
    enabled ? row._id : undefined,
    row.viewer,
  );
  return (
    <>
      {enabled && <SteerClaimFeeder scope={row._id} viewerId={row.viewer} />}
      {row.owner
        ? owner(row._id, control)
        : collaborator(row._id, control ?? { enabled: false })}
    </>
  );
}

async function show(
  row: SteerClaimState,
  status: string | { status: string; code?: string } = "acknowledged",
  enabled = true,
) {
  const ui = await mount(<Composer row={row} enabled={enabled} />, {
    setup(backend) {
      backend.set(api.collab.steerClaimState, row);
      backend.set(api.collab.mySendAccess, { level: "shared" });
      backend.set(api.devices.getConversationMachine, null);
      backend.mutation(
        api.dispatch.dispatch,
        typeof status === "string" ? { status } : status,
      );
    },
  });
  await act(async () => flushSyncPublishes());
  return {
    ...ui,
    async press(...args: Parameters<typeof ui.press>) {
      await ui.press(...args);
      await settleRecoveryWrites();
    },
  };
}

async function publishClaim(
  ui: Awaited<ReturnType<typeof show>>,
  row: SteerClaimState | null,
) {
  await act(() => ui.backend.set(api.collab.steerClaimState, row));
  await act(async () => flushSyncPublishes());
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
  await ui.press("Enter");
  const sent = ui.backend.mutations.at(-1)?.args as {
    args: [string, Record<string, unknown>];
  };
  expect(sent.args[1]).toMatchObject({ kind: "send", text: "Queue this" });
  expect(sent.args[1]).not.toHaveProperty("observed");
  await publishClaim(ui, {
    ...row,
    queue: {
      items: [{ id: "queued" as Id<"pending_messages">, sender: row.viewer }],
      more: false,
    },
  });
  expect(ui.container.textContent).toContain("Waiting for Ana");
  for (const [delivery, text] of [
    ["delivery-started", "With the agent"],
    ["ambiguous", "Delivery in doubt"],
  ] as const) {
    await publishClaim(ui, { ...row, delivery });
    expect(ui.container.textContent).toContain(text);
  }
  await publishClaim(ui, null);
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
  const ui = await show(row);
  const reply = Promise.withResolvers<{ status: string }>();
  ui.backend.mutation(api.dispatch.dispatch, () => reply.promise);
  await act(() => button(ui.container, "Ask to drive").click());
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
  expect(
    useInboxStore.getState().fencedSteerClaims[row._id]?.drive_requested,
  ).toBe(true);
  const lock = `fencedSteerClaims:${row._id}:drive_requested`;
  expect(useInboxStore.getState().pending[lock]).toMatchObject({
    type: "field",
    value: true,
  });
  await publishClaim(ui, { ...row, fresh_for_ms: 29000 });
  expect(useInboxStore.getState().pending[lock]).toMatchObject({
    seen: [false],
  });
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [row._id, { kind: "ask" }],
  });
  await publishClaim(ui, {
    ...row,
    drive_requested: true,
  });
  await act(() => reply.resolve({ status: "requested" }));
  expect(useInboxStore.getState().pending[lock]).toBeUndefined();
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
});

test("takeover requires confirmation for the exact instance and cancel passes the fence id", async () => {
  const row = { ...claimState(), holder: driver, can_steer: false };
  const ui = await show(row);
  const reply = Promise.withResolvers<{ status: string }>();
  ui.backend.mutation(api.dispatch.dispatch, () => reply.promise);
  await act(() => button(ui.container, "Take over").click());
  expect(ui.backend.mutations).toHaveLength(0);
  const confirm = ui.dom.window.document.querySelector<HTMLButtonElement>(
    "[data-switch-confirm]",
  )!;
  await act(() => confirm.click());
  expect(ui.container.textContent).toContain("Waiting for the machine");
  expect(
    useInboxStore.getState().fencedSteerClaims[row._id]?.takeover_pending,
  ).toBe(true);
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
  await publishClaim(ui, {
    ...row,
    takeover_pending: true,
    fence_id: "fence",
  });
  await act(() => reply.resolve({ status: "pending" }));
  const cancel = Promise.withResolvers<{ status: string }>();
  ui.backend.mutation(api.dispatch.dispatch, () => cancel.promise);
  await act(() => button(ui.container, "Cancel takeover").click());
  expect(ui.container.textContent).not.toContain("Waiting for the machine");
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [row._id, { kind: "cancel", fenceId: "fence" }],
  });
  await act(() => cancel.resolve({ status: "cancelled" }));
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

test.each([
  ["stale", { status: "rejected", code: "STALE_TURN" }, "Turn ended"],
  ["refused", { status: "refused" }, "Send refused"],
] as const)(
  "a %s send restores the draft and offers Queue",
  async (_kind, result, label) => {
    const row = {
      ...claimState(),
      can_take_over: false,
      can_steer: _kind === "stale",
    };
    const ui = await show(row, result);
    await ui.type("Keep this draft");
    await ui.press("Enter");
    expect(ui.box().value).toBe("Keep this draft");
    expect(ui.container.textContent).toContain(label);
    expect(button(ui.container, "Queue")).toBeTruthy();
    await publishClaim(ui, {
      ...row,
      ...(_kind === "stale" ? { can_take_over: true } : { can_steer: true }),
    });
    expect(ui.container.textContent).not.toContain(label);
    expect(button(ui.container, "Send")).toBeTruthy();
  },
);

test.each(["run", "start_event_seq", "baton_token"] as const)(
  "takeover confirmation expires when %s changes",
  async (field) => {
    const row = { ...claimState(), holder: driver, can_steer: false };
    const ui = await show(row);
    await act(() => button(ui.container, "Take over").click());
    const next =
      field === "baton_token"
        ? { ...row, baton_token: 2 }
        : { ...row, turn: { ...row.turn!, [field]: row.turn![field] + 1 } };
    await publishClaim(ui, next);
    const confirm = ui.dom.window.document.querySelector<HTMLButtonElement>(
      "[data-switch-confirm]",
    )!;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Driver or turn changed");
    await act(() => confirm.click());
    expect(ui.backend.mutations).toHaveLength(0);
  },
);

function isEscape(args: unknown) {
  return (
    !!args &&
    typeof args === "object" &&
    "action" in args &&
    args.action === "convCommand" &&
    "args" in args &&
    Array.isArray(args.args) &&
    args.args[1] === "sendEscapeToSession"
  );
}

test("a live owner can interrupt from the strip and keyboard while another person drives", async () => {
  const row = { ...claimState(), holder: driver, can_steer: false };
  const ui = await show(row);
  await ui.press("Escape");
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "convCommand",
    args: [row._id, "sendEscapeToSession", {}],
  });
  const next = { ...row, turn: { ...row.turn!, start_event_seq: 11 } };
  await publishClaim(ui, next);
  await act(() => button(ui.container, "Interrupt").click());
  expect(
    ui.backend.mutations.filter(({ args }) => isEscape(args)),
  ).toHaveLength(2);
  await publishClaim(ui, {
    ...row,
    turn: { ...row.turn!, start_event_seq: 12 },
  });
  await ui.type("After the stop");
  await ui.press("Escape", { shiftKey: true });
  expect(
    ui.backend.mutations.filter(({ args }) => isEscape(args)),
  ).toHaveLength(3);
  expect(ui.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [row._id, { kind: "send", text: "After the stop" }],
  });
  const send = ui.backend.mutations.at(-1)?.args as { args: [string, object] };
  expect(send.args[1]).not.toHaveProperty("observed");
});

test("a sender who drives cannot interrupt without session command access", async () => {
  const ui = await show({
    ...claimState(),
    owner: false,
    can_take_over: false,
  });
  expect(ui.container.textContent).toContain("Driving · You");
  expect(ui.container.textContent).not.toContain("Interrupt");
  await ui.press("Escape");
  expect(ui.backend.mutations.some(({ args }) => isEscape(args))).toBe(false);
});

test("the collaborator only interrupts on plain Escape with an empty draft", async () => {
  const row = { ...claimState(), owner: false, can_take_over: false };
  const ui = await show(row);
  await act(async () => {
    useInboxStore
      .getState()
      .syncTable("conversations", [{ _id: row._id, user_id: row.viewer }]);
    flushSyncPublishes();
  });
  expect(button(ui.container, "Interrupt")).toBeTruthy();
  await ui.press("Escape", { shiftKey: true });
  await ui.type("Keep these words");
  await ui.press("Escape");
  await ui.press("Escape", { shiftKey: true });
  expect(ui.box().value).toBe("Keep these words");
  expect(ui.backend.mutations.some(({ args }) => isEscape(args))).toBe(false);
  await ui.type("");
  await ui.press("Escape");
  expect(
    ui.backend.mutations.filter(({ args }) => isEscape(args)),
  ).toHaveLength(1);
});

function persistedRetries(row: SteerClaimState) {
  return db.meta
    .where("key")
    .startsWith(`${COMPOSER_RETRY_PREFIX}${row.viewer}:${row._id}:`)
    .toArray();
}

test("a follower reload recovers the committed command, and acceptance deletes it from IndexedDB", async () => {
  const row = claimState();
  const ui = await show(row);
  const store = useInboxStore.getState();
  const follower = replicationPersistence(useInboxStore.getState);
  (
    store as typeof store & {
      _setIDBWrite: (write: typeof follower.followerWrite) => void;
    }
  )._setIDBWrite(follower.followerWrite);
  const reply = Promise.withResolvers<{ status: string }>();
  const beforeDispatch =
    Promise.withResolvers<Awaited<ReturnType<typeof persistedRetries>>>();
  ui.backend.mutation(api.dispatch.dispatch, async ({ action }) => {
    if (action !== "controlSteerComposer") return {};
    beforeDispatch.resolve(await persistedRetries(row));
    return reply.promise;
  });
  await ui.type("Keep this across reload");
  await ui.press("Enter");
  const saved = await beforeDispatch.promise;
  const original = ui.backend.mutations.at(-1)?.args;
  expect(original).toBeDefined();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.value).toMatchObject({
    payload: { text: "Keep this across reload" },
  });
  expect(ui.box().value).toBe("");
  await ui.close();

  const reloaded = await show(row);
  await settleRecoveryWrites();
  const retry = reloaded.container.querySelector(
    '[aria-label="Draft to retry"]',
  );
  expect(retry?.textContent).toContain("Keep this across reload");
  expect(reloaded.backend.mutations).toHaveLength(0);
  await act(async () => button(reloaded.container, "Retry").click());
  await settleRecoveryWrites();
  expect(reloaded.backend.mutations.at(-1)?.args).toEqual(original);
  expect(await persistedRetries(row)).toEqual([]);
  expect(
    reloaded.container.querySelector('[aria-label="Draft to retry"]'),
  ).toBeNull();
});

test.each([
  { owner: true, hydrating: true },
  { owner: false, hydrating: true },
  { owner: true, hydrating: false },
])(
  "the editor keeps its draft without writable storage (%j)",
  async ({ owner, hydrating }) => {
    const row = { ...claimState(), owner };
    const ui = await show(row);
    setHydrating(hydrating);
    if (!hydrating)
      principalStorage.setItem(
        AUTH_JWT_STORAGE_KEY,
        issueFakeToken("different-account"),
      );
    try {
      await ui.type("Still in the editor");
      await ui.press("Enter");
      expect(ui.box().value).toBe("Still in the editor");
      expect(
        ui.backend.mutations.some(
          ({ args }) =>
            (args as { action?: string } | undefined)?.action ===
            "controlSteerComposer",
        ),
      ).toBe(false);
      expect(await persistedRetries(row)).toEqual([]);
    } finally {
      setHydrating(false);
      principalStorage.setItem(
        AUTH_JWT_STORAGE_KEY,
        issueFakeToken(signedInViewer),
      );
    }
  },
);

test("a redacted recovery retries the same client id and turn address", async () => {
  const row = { ...claimState(), owner: false };
  const ui = await show(row);
  const credentials = `ghp_${"a".repeat(36)}`;
  const reply = Promise.withResolvers<{ status: string }>();
  ui.backend.mutation(api.dispatch.dispatch, ({ action }) =>
    action === "controlSteerComposer" ? reply.promise : {},
  );
  await ui.type(`Use ${credentials}`);
  await ui.press("Enter");
  const original = ui.backend.mutations.find(
    ({ args }) =>
      (args as { action?: string } | undefined)?.action ===
      "controlSteerComposer",
  )?.args as { args: [string, { clientId: string; observed: unknown }] };
  expect(original.args[1].clientId).toBeTruthy();
  expect((await persistedRetries(row))[0]?.value.command).toMatchObject({
    clientId: original.args[1].clientId,
    text: "Use [redacted:github-token]",
  });
  expect(JSON.stringify(await persistedRetries(row))).not.toContain(
    credentials,
  );
  await ui.close();
  const reloaded = await show(row);
  await settleRecoveryWrites();
  await act(async () => button(reloaded.container, "Retry").click());
  await settleRecoveryWrites();
  expect(reloaded.backend.mutations.at(-1)?.args).toMatchObject({
    action: "controlSteerComposer",
    args: [
      row._id,
      {
        clientId: original.args[1].clientId,
        observed: original.args[1].observed,
        text: "Use [redacted:github-token]",
      },
    ],
  });
});

test.each(["retry", "dismiss"] as const)(
  "a transient send can %s without leaving an outbox replay",
  async (resolution) => {
    const row = claimState();
    const ui = await show(row);
    const store = useInboxStore.getState() as ReturnType<
      typeof useInboxStore.getState
    > & {
      _setOutbox: (
        enqueue: (entry: OutboxEntry) => Promise<void>,
        remove: (id: string) => Promise<void>,
        load: () => Promise<OutboxEntry[]>,
      ) => void;
    };
    const outbox = new Map<string, OutboxEntry>();
    store._setOutbox(
      async (entry) => {
        outbox.set(entry.id, entry);
      },
      async (id) => {
        outbox.delete(id);
      },
      async () => [...outbox.values()],
    );
    const sends: unknown[][] = [];
    let online = false;
    store._setDispatchError(() => {});
    store._setDispatch(async (action, args) => {
      if (action === "controlSteerComposer") {
        sends.push(args);
        if (!online) throw new Error("Connection lost");
      }
      return { status: "acknowledged" };
    });
    const parkedSteers = () =>
      [...outbox.values()].filter(
        (entry) => entry.action === "controlSteerComposer",
      );
    await ui.type("Send once");
    await ui.press("Enter");
    for (const delay of [1000, 2000, 4000]) await ui.clock!.advance(delay);
    expect(sends).toHaveLength(4);
    const initial = sends[0];
    expect(ui.container.textContent).toContain("Delivery in doubt");
    await settleRecoveryWrites();
    expect(parkedSteers()).toEqual([]);
    online = true;
    await act(async () =>
      button(
        ui.container,
        resolution === "retry" ? "Retry" : "Dismiss",
      ).click(),
    );
    await settleRecoveryWrites();
    expect(
      ui.container.querySelector('[aria-label="Draft to retry"]'),
    ).toBeNull();
    if (resolution === "retry") {
      expect(sends).toHaveLength(5);
      expect(sends.at(-1)).toEqual(initial);
    } else {
      expect(sends).toHaveLength(4);
    }
    expect(await persistedRetries(row)).toEqual([]);
    expect(parkedSteers()).toEqual([]);
  },
);

test.each([
  ["Allow", "granted"],
  ["Deny", "denied"],
  ["Revoke", "revoked"],
] as const)(
  "grant %s paints immediately and accepts the server echo",
  async (action, status) => {
    const row = claimState();
    const grant = {
      grant_id: "grant" as Id<"collab_grants">,
      grantee_user_id: row.viewer,
      grantee_name: "A teammate",
      grantee_image: null,
      status: action === "Revoke" ? "granted" : "requested",
      updated_at: 1,
    };
    const reply = Promise.withResolvers<{ status: string }>();
    const ui = await mount(<CollabRequestBanner conversationId={row._id} />, {
      setup(backend) {
        backend.set(api.collab.collabRequests, [grant]);
        backend.set(api.guestSuggestions.listPending, []);
        backend.mutation(api.dispatch.dispatch, () => reply.promise);
      },
    });
    await act(() => button(ui.container, action).click());
    expect(
      useInboxStore.getState().collabRequests[grant.grant_id]?.status,
    ).toBe(status);
    if (status === "granted")
      expect(button(ui.container, "Revoke")).toBeTruthy();
    else expect(ui.container.textContent).not.toContain("A teammate");
    await act(() =>
      ui.backend.set(
        api.collab.collabRequests,
        status === "granted" ? [{ ...grant, status }] : [],
      ),
    );
    await act(() => reply.resolve({ status }));
    expect(
      useInboxStore.getState().collabRequests[grant.grant_id]?.status,
    ).toBe(status === "granted" ? status : undefined);
  },
);

test("a server echo keeps a drive request when its dispatch response is lost", async () => {
  const row = {
    ...claimState(),
    owner: false,
    holder: driver,
    can_send: false,
    can_steer: false,
    can_take_over: false,
  };
  const ui = await show(row);
  const reply = Promise.withResolvers<never>();
  const store = useInboxStore.getState();
  store._setDispatchError(() => {});
  store._setDispatch(() => reply.promise);
  await act(() => button(ui.container, "Ask to drive").click());
  await publishClaim(ui, { ...row, drive_requested: true });
  await act(() => reply.reject(new Error("Connection lost")));
  for (const delay of [1000, 2000, 4000]) await ui.clock!.advance(delay);
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
});

test("a lease refresh leaves the stored claim and composer selection unchanged", async () => {
  const row = claimState();
  const reads: unknown[] = [];
  function Probe() {
    reads.push(useLiveComposerControl(row._id, row.viewer));
    return null;
  }
  const ui = await mount(
    <>
      <SteerClaimFeeder scope={row._id} viewerId={row.viewer} />
      <Probe />
    </>,
    { setup: (backend) => backend.set(api.collab.steerClaimState, row) },
  );
  await act(async () => flushSyncPublishes());
  const before = useInboxStore.getState().fencedSteerClaims[row._id];
  const count = reads.length;
  const view = reads.at(-1);
  expect(view).toBeDefined();
  await publishClaim(ui, { ...row, fresh_for_ms: 29000 });
  expect(useInboxStore.getState().fencedSteerClaims[row._id]).toBe(before);
  expect(reads).toHaveLength(count);
  expect(reads.at(-1)).toBe(view);
  await publishClaim(ui, {
    ...row,
    queue: {
      items: [{ id: "queued" as Id<"pending_messages">, sender: driver.id }],
      more: false,
    },
  });
  expect(
    useInboxStore.getState().fencedSteerClaims[row._id]?.queue.items,
  ).toHaveLength(1);
  expect(reads).toHaveLength(count);
});
