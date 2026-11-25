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
