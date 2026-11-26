import { expect, test } from "bun:test";
import { act } from "react";
import { ConvexError } from "convex/values";
import { api } from "@codecast/convex/convex/_generated/api";
import { webBuilders } from "../../test-helpers/builders";
import { button } from "../../test-helpers/composer-control-fixture";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { testToasts } from "../../test-helpers/testToasts";
import { DispatchFailureToast } from "../dispatch-failure-toast";
import { ProjectSwitcher } from "./session-controls";
import { useSyncDeliveryReceipts } from "../../hooks/useSyncDeliveryReceipts";
import { syncLogScopeMetaKey } from "../../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

const builders = webBuilders("session-move-refusal.mount.test.tsx");
const path = "/Users/me/source/project";
const studioPath = "/Users/me/work/project";
const laptop = {
  device_id: "laptop",
  label: "Laptop",
  platform: "darwin",
  online: true,
  is_remote: false,
  last_seen: Date.now(),
  local_project_roots: [path],
};
const studio = {
  ...laptop,
  device_id: "studio",
  label: "Studio",
  local_project_roots: [studioPath],
};
const cloud = {
  ...laptop,
  device_id: "cloud",
  label: "Cloud Linux",
  platform: "linux",
  is_remote: true,
  local_project_roots: [],
  cloud_host: {
    managed_by: laptop.device_id,
    instance_id: "i-1",
    provider: "aws" as const,
    state: "running" as const,
    images: [],
    logins_held: [],
    at: Date.now(),
  },
};
const refusal = "Only the session's runner can change its machine";

test.each(["machine pick", "cloud toggle"] as const)(
  "a refused %s shows one readable toast",
  async (control) => {
    const notices = testToasts();
    const row = builders.conversation.build({
      owner_device_id: laptop.device_id,
      project_path: path,
      git_root: path,
    });
    const ui = await mountWeb(
      <>
        <ProjectSwitcher conversation={{ ...row, messages: [] }} />
        <DispatchFailureToast />
      </>,
      {
        dispatch: true,
        expectedConsoleErrors: [
          /\[CONVEX M\(dispatch:dispatch\)\].*\[Request ID: fake\]/,
          /\[sync\] dispatch failed after retries: convCommand/,
        ],
        setup(backend, store) {
          store.syncTable("sessions", [
            builders.session.build({
              _id: row._id,
              owner_device_id: laptop.device_id,
              project_path: path,
              git_root: path,
            }),
          ]);
          store.setMachineRoster([laptop, studio, cloud]);
          backend.set(api.devices.listDevices, pending);
          backend.set(api.users.getRecentProjectPaths, []);
          backend.set(api.teamHosts.list, []);
          backend.mutation(api.dispatch.dispatch, ({ action, args }) => {
            if (action !== "convCommand") return null;
            expect(args.slice(0, 2)).toEqual([row._id, "reconfigureSession"]);
            const error = new ConvexError(refusal);
            error.message = `[Request ID: fake] Server Error\nUncaught ConvexError: "${refusal}"`;
            return error;
          });
        },
      },
    );
    if (control === "machine pick") {
      const machine = ui.container.querySelector<HTMLButtonElement>(
        'button[title^="Runs on Laptop."]',
      )!;
      await act(async () => machine.click());
      await act(async () => button(ui.container, "Studio").click());
    } else {
      await act(async () => button(ui.container, "run in the cloud").click());
    }
    expect(
      ui.container.querySelector('button[title^="Runs on Laptop."]'),
    ).not.toBeNull();
    expect(
      ui.store.getState().clientState.ui?.last_picked_device_id,
    ).toBeUndefined();
    expect(
      notices.events().map(({ event, kind, title }) => ({
        event,
        kind,
        title,
      })),
    ).toEqual([
      {
        event: "show",
        kind: "error",
        title: `Reconfigure session didn't go through — ${refusal}`,
      },
    ]);
  },
);

test("a machine pick stays with its conversation when the switcher is reused", async () => {
  const rows = Array.from({ length: 2 }, () =>
    builders.conversation.build({
      owner_device_id: laptop.device_id,
      project_path: path,
      git_root: path,
    }),
  );
  const switcher = (row: (typeof rows)[number]) => (
    <ProjectSwitcher conversation={{ ...row, messages: [] }} />
  );
  const ui = await mountWeb(switcher(rows[0]), {
    dispatch: true,
    setup(backend, store) {
      store.syncTable(
        "sessions",
        rows.map((row) =>
          builders.session.build({
            _id: row._id,
            owner_device_id: laptop.device_id,
            project_path: path,
            git_root: path,
          }),
        ),
      );
      store.setMachineRoster([laptop, studio, cloud]);
      backend.set(api.devices.listDevices, pending);
      backend.set(api.users.getRecentProjectPaths, []);
      backend.set(api.teamHosts.list, []);
      backend.mutation(api.dispatch.dispatch, () => null);
    },
  });

  const machine = (label: string) =>
    ui.container.querySelector<HTMLButtonElement>(
      `button[title^="Runs on ${label}."]`,
    );
  await act(async () => machine("Laptop")!.click());
  await act(async () => button(ui.container, "Studio").click());
  expect(machine("Studio")).not.toBeNull();

  await ui.rerender(switcher(rows[1]));
  expect(machine("Laptop")).not.toBeNull();
  expect(machine("Studio")).toBeNull();

  await ui.rerender(switcher(rows[0]));
  expect(machine("Studio")).not.toBeNull();
});

function DeliveryReceipts() {
  useSyncDeliveryReceipts();
  return null;
}

test.each([
  ["online", true],
  ["offline", false],
] as const)(
  "an accepted move to an %s machine releases its locks after V2 delivery",
  async (_status, online) => {
    const row = builders.conversation.build({
      owner_device_id: laptop.device_id,
      project_path: path,
      git_root: path,
    });
    const serverRow = builders.session.build({
      _id: row._id,
      owner_device_id: laptop.device_id,
      project_path: path,
      git_root: path,
    });
    const scope = "user:picker";
    const receipt = { id: "r".repeat(32) as Id<"sync_outbox">, revision: 2 };
    const locks = ["owner_device_id", "project_path", "git_root"].map(
      (field) => `sessions:${row._id}:${field}`,
    );
    const response = Promise.withResolvers<unknown>();
    const ui = await mountWeb(
      <>
        <ProjectSwitcher conversation={{ ...row, messages: [] }} />
        <DeliveryReceipts />
      </>,
      {
        dispatch: true,
        setup(backend, store) {
          store.syncTable("sessions", [serverRow]);
          store.setMachineRoster([laptop, { ...studio, online }]);
          backend.set(api.devices.listDevices, pending);
          backend.set(api.users.getRecentProjectPaths, []);
          backend.set(api.teamHosts.list, []);
          backend.set(api.syncOutbox.getReceipts, ({ receipts }) => {
            expect(receipts).toEqual([receipt]);
            return pending;
          });
          backend.mutation(
            api.dispatch.dispatch,
            ({ action, args, patches }) => {
              if (action !== "convCommand" || args[1] !== "reconfigureSession")
                return null;
              expect(args[0]).toBe(row._id);
              expect(args[2]).toMatchObject({
                target_device_id: studio.device_id,
              });
              expect(patches?.conversations?.[row._id]).toBeUndefined();
              return response.promise;
            },
          );
        },
      },
    );
    const machine = (label: string) =>
      ui.container.querySelector<HTMLButtonElement>(
        `button[title^="Runs on ${label}."]`,
      );
    const session = () => ui.store.getState().sessions[row._id];
    const preference = () =>
      ui.store.getState().clientState.ui?.last_picked_device_id;

    await act(async () => machine("Laptop")!.click());
    await act(async () => button(ui.container, "Studio").click());
    expect(machine("Studio")).not.toBeNull();
    expect(session().project_path).toBe(studioPath);
    expect(preference()).toBeUndefined();

    await act(async () => {
      response.resolve({
        __syncAckV1: [],
        __syncAckV2: [
          { ...receipt, entity_type: "conversations", entity_id: row._id },
        ],
        result: null,
      });
    });
    expect(session().project_path).toBe(studioPath);
    expect(preference()).toBe(studio.device_id);

    await act(async () => {
      ui.store.getState().syncTable("sessions", [serverRow]);
      ui.backend.set(api.syncOutbox.getReceipts, [
        {
          ...receipt,
          scope_key: scope,
          position: 17,
        },
      ]);
    });
    expect(session().project_path).toBe(studioPath);
    for (const key of locks)
      expect(ui.store.getState().pending[key]).toBeDefined();

    await act(async () => {
      ui.store
        .getState()
        .recordSyncMeta(syncLogScopeMetaKey(scope), { cursor: 17 });
    });
    for (const key of locks)
      expect(ui.store.getState().pending[key]).toBeUndefined();
    expect(session()).toMatchObject({
      owner_device_id: laptop.device_id,
      project_path: path,
      git_root: path,
    });
    expect(machine("Laptop")).not.toBeNull();
  },
);

test("the stub's cloud pick stays visible through rekey until its owner arrives", async () => {
  const serverRow = builders.conversation.build({
    project_path: path,
    git_root: path,
  });
  const stubId = "stub-project-picker" as typeof serverRow._id;
  const ui = await mountWeb(
    <ProjectSwitcher
      conversation={{ ...serverRow, _id: stubId, messages: [] }}
    />,
    {
      dispatch: true,
      setup(backend, store) {
        store.seedSession(
          builders.session.build({
            _id: stubId,
            session_id: stubId,
            project_path: path,
            git_root: path,
          }),
        );
        store.setMachineRoster([laptop, cloud]);
        backend.set(api.devices.listDevices, pending);
        backend.set(api.users.getRecentProjectPaths, []);
        backend.set(api.teamHosts.list, []);
        backend.mutation(api.dispatch.dispatch, () => null);
      },
    },
  );
  const machine = (label: string) =>
    ui.container.querySelector(`button[title^="Runs on ${label}."]`);
  expect(machine("Laptop")).not.toBeNull();
  await act(async () => button(ui.container, "run in the cloud").click());
  expect(machine("Cloud Linux")).not.toBeNull();

  await act(async () =>
    ui.store.getState().resolveSessionId(stubId, serverRow._id),
  );
  expect(
    ui.store.getState().sessions[serverRow._id].owner_device_id,
  ).toBeUndefined();
  expect(machine("Cloud Linux")).not.toBeNull();

  await act(async () => {
    ui.store.getState().syncTable("sessions", [
      builders.session.build({
        _id: serverRow._id,
        session_id: stubId,
        updated_at: Date.now(),
        owner_device_id: laptop.device_id,
        project_path: path,
        git_root: path,
      }),
    ]);
  });
  expect(ui.store.getState().resolveLiveSessionId(stubId)).toBe(serverRow._id);
  await ui.rerender(
    <ProjectSwitcher conversation={{ ...serverRow, messages: [] }} />,
  );
  expect(machine("Laptop")).not.toBeNull();
});
