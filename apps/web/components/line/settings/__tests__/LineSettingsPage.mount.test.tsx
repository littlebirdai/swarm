import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../../../store/inboxStore";
import { webBuilders } from "../../../../test-helpers/builders";
import {
  expectAbsent,
  expectPresent,
} from "../../../../test-helpers/domExpect";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import { pending } from "../../../../test-helpers/testConvex";
import { waitForDom } from "../../../../test-helpers/waitForDom";

const realStations = { ...(await import("../LineStations")) };
mock.module("../LineStations", () => ({
  ...realStations,
  LineStations: ({
    projectId,
    focusStation,
  }: Parameters<typeof realStations.LineStations>[0]) => (
    <div
      data-stations-slot={projectId}
      data-focus-station={focusStation ?? ""}
    />
  ),
}));
afterAll(() => {
  mock.module("../LineStations", () => realStations);
});

const { LineSettingsPage } = await import("../LineSettingsPage");
const builders = webBuilders("line settings");
const ME = builders.teamMember.build({ name: "Me" });
const WS = `user:${ME._id}`;
const now = Date.now();
const lineProfile = {
  finders: [
    {
      id: "sentry-web",
      source: "sentry",
      kind: ["bug"],
      fingerprint: "sentry:<issue>",
    },
    {
      id: "evals",
      source: "evals",
      kind: ["regression"],
      fingerprint: "evals:<surface>",
      runs: "cast trigger tr-9",
    },
  ],
  root: "/src/codecast",
  default: true,
  changed_at: now - 30 * 86_400_000,
  team: null,
  project: "pr-1",
  principles: ["docs/principles.md"],
  prompting:
    "https://github.com/codecast-sh/codecast/blob/main/docs/prompting.md",
  size_budget: 300,
  watch_days: 7,
  commands: { check: "cast check", prove: null, eval: null, ship: null },
  caps: { cards: 5 },
  sources: {
    principles: "file",
    prompting: "default",
    size_budget: "file",
    watch_days: "default",
    "commands.check": "file",
    "commands.prove": "default",
    "commands.eval": "default",
    "commands.ship": "default",
    "caps.cards": "default",
    finders: "file",
  },
  notes: [
    "no prove command: the prove station passes with a note",
    "no eval command: the eval station passes with a note",
    "no ship command: the ship station runs Ship, which opens a pull request and merges only under [line.merge] auto or the line's role's merge grant",
  ],
  warnings: [],
  file: ".codecast/line.toml",
  device_id: "mac-1",
  published_at: now - 1000,
};

const project = builders.project.build({
  short_id: "pr-1",
  title: "Codecast",
  workspace: WS,
});
const task = builders.task.build({
  short_id: "ct-1",
  title: "cause",
  status: "open",
  workspace: WS,
  project_id: project._id,
  created_at: now - 9e6,
  updated_at: now,
});
const cause = { signal_count: 1, first_seen: now - 9e6, last_seen: now };
const signal = {
  _id: "s1",
  short_id: "sg-1",
  source: "sentry",
  kind: "bug" as const,
  title: "TypeError in header",
  subject: "web",
  observed_at: now - 3_600_000,
  created_at: now - 3_600_000,
  task_id: task._id,
  project_id: project._id,
  workspace: WS,
};

function mount({
  online = true,
  owned = true,
  search = "",
  acknowledgement = Promise.resolve({ command_id: "cmd-1" }),
} = {}) {
  const scrolled: string[] = [];
  const web = mountWeb(<LineSettingsPage />, {
    path: "/flows/settings?project=pr-1" + search,
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", ME);
      store.syncTable("clientState", { ui: {} });
      store.syncTable("projects", [{ ...project, line_profile: lineProfile }]);
      store.syncTable("tasks", [{ ...task, cause }]);
      store.syncTable("signals", [signal]);
      const machine = {
        device_id: owned ? "mac-1" : "someone-else",
        label: owned ? "Studio" : "Their Mac",
        platform: "darwin",
        online,
        last_seen: now,
        is_remote: false,
      };
      useInboxStore.setState({
        machineRoster: [machine],
        machineRosterLive: true,
      });
      backend.set(api.org.roles, pending);
      backend.set(api.devices.listDevices, pending);
      backend.set(api.projects.webList, pending);
      backend.set(api.tasks.webList, pending);
      backend.set(api.signals.webList, [
        {
          ...signal,
          _id: signal._id as Id<"signals">,
          task_id: task._id as Id<"tasks">,
          project_id: project._id as Id<"projects">,
          fingerprint: "sentry:header",
          detail_md: undefined,
          evidence_url: undefined,
          goal_hint: undefined,
          filed_for_project_id: undefined,
          attach: "fingerprint",
          reopened: false,
          user_id: ME._id,
        },
      ]);
      backend.set(api.workflow_runs.listRuns, []);
      backend.mutation(api.dispatch.dispatch, () => acknowledgement);
      HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this.getAttribute("data-lset-section") ?? this.tagName);
      };
    },
  });
  return web.then((mounted) => ({ ...mounted, scrolled }));
}

const row = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLElement>("[data-lset-row]")].find(
    (r) => r.querySelector(".lset-label")?.textContent === label,
  )!;

test("the sections read in order, each value says where it came from, and the Stations slot gets the project", async () => {
  const { container: host, close } = await mount();
  expect(
    [...host.querySelectorAll("[data-lset-section]")].map((s) =>
      s.getAttribute("data-lset-section"),
    ),
  ).toEqual(["listens", "holds", "checks", "limits", "stations"]);
  expect(row(host, "Check").querySelector(".lset-value")!.textContent).toBe(
    "cast check",
  );
  expect(row(host, "Check").querySelector(".lset-src")!.textContent).toBe(
    "file",
  );
  expect(row(host, "Watch").querySelector(".lset-src")!.textContent).toBe(
    "default",
  );
  expect(
    row(host, "Reproduce").querySelector("[data-lset-note]")!.textContent,
  ).toBe("the prove station passes with a note");
  expect(row(host, "Check").querySelector("[data-lset-note]")).toBeNull();
  const finders = [...host.querySelectorAll<HTMLElement>("[data-lset-finder]")];
  expect(finders.map((f) => f.getAttribute("data-lset-finder"))).toEqual([
    "sentry-web",
    "evals",
  ]);
  expect(
    finders[0].querySelector("[data-lset-finder-health]")!.textContent,
  ).toBe("healthy, 1 today");
  expect(finders[1].getAttribute("data-silent")).toBe("true");
  expect(
    finders[1].querySelector("[data-lset-finder-health]")!.textContent,
  ).toBe("quiet for 14d+");
  expect(
    host
      .querySelector("[data-stations-slot]")!
      .getAttribute("data-stations-slot"),
  ).toBe(project._id);
  expect(
    host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate"),
  ).toBe("writable");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(
    /Studio/,
  );
  await close();
});

test("an edit shows at once and waits on the machine; a daemon refusal stops showing it, with the loader's message", async () => {
  const ack = Promise.withResolvers<{ command_id: string }>();
  const {
    container: host,
    close,
    backend,
  } = await mount({ acknowledgement: ack.promise });
  const button = row(host, "Size budget").querySelector<HTMLButtonElement>(
    ".lset-value",
  )!;
  await act(async () => {
    button.click();
  });
  const input = row(host, "Size budget").querySelector<HTMLInputElement>(
    "input",
  )!;
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(input, "120");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  const value = () =>
    row(host, "Size budget").querySelector(".lset-value")?.textContent;
  const state = () =>
    row(host, "Size budget")
      .querySelector(".lset-status")
      ?.getAttribute("data-state");
  expect(value()).toBe("120");
  expect(state()).toBe("sending");
  const [entry] = Object.values(useInboxStore.getState().sessionCommands);
  expectPresent(entry);
  expect(backend.mutations).toEqual([
    {
      name: "dispatch:dispatch",
      args: {
        ack_positions: true,
        patches: {},
        result: null,
        action: "editLineProfile",
        args: [
          entry._id,
          project._id,
          [{ op: "set", key: "size_budget", value: 120 }],
        ],
      },
    },
  ]);
  await act(async () => ack.resolve({ command_id: "cmd-1" }));
  await act(async () => {
    useInboxStore.getState().syncTable(
      "sessionCommands",
      [
        {
          ...entry,
          command_id: "cmd-1",
        },
      ],
      { isDelta: true },
    );
    await waitForDom(
      host,
      () =>
        row(host, "Size budget")
          .querySelector(".lset-status")
          ?.getAttribute("data-state") === "waiting",
    );
  });
  expect(value()).toBe("120");
  expect(state()).toBe("waiting");

  await act(async () => {
    useInboxStore.getState().syncTable(
      "sessionCommands",
      [
        {
          ...entry,
          command_id: "cmd-1",
          executed_at: Date.now(),
          error:
            "/src/codecast/.codecast/line.toml: [line] size_budget must be at most 2000",
        },
      ],
      { isDelta: true },
    );
    await waitForDom(
      host,
      () =>
        row(host, "Size budget")
          .querySelector(".lset-status")
          ?.getAttribute("data-state") === "refused",
    );
  });
  const status = row(host, "Size budget").querySelector(".lset-status")!;
  expect(status.getAttribute("data-state")).toBe("refused");
  expect(status.textContent).toMatch(/size_budget must be at most 2000/);
  expect(
    row(host, "Size budget").querySelector(".lset-value")!.textContent,
  ).toBe("300");
  await close();
});

test("a quiet machine still takes edits, and says how long one waits for it", async () => {
  const { container: host, close } = await mount({ online: false });
  expect(
    host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate"),
  ).toBe("writable");
  expect(
    host.querySelector("[data-lset-plate]")!.getAttribute("data-away"),
  ).toBe("true");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(
    /Studio has not checked in.*up to 5 minutes/,
  );
  await close();
});

test("a teammate's machine makes the page read only and says why", async () => {
  const { container: host, close } = await mount({ owned: false });
  expect(
    host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate"),
  ).toBe("read-only");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(
    /teammate's machine/,
  );
  const value = row(host, "Check").querySelector<HTMLButtonElement>(
    ".lset-value",
  )!;
  expect(value.getAttribute("aria-disabled")).toBe("true");
  expect(value.disabled).toBe(false);
  await act(async () => {
    value.click();
  });
  expect(row(host, "Check").querySelector("[data-lset-input]")).toBeNull();
  expect(host.querySelector(".lset-add")).toBeNull();
  await close();
});

test("a link in lands on its section or station: scrolled to, and marked to flash once", async () => {
  const limits = await mount({ search: "&section=limits" });
  expect(
    [...limits.container.querySelectorAll("[data-lset-target]")].map((node) =>
      node.getAttribute("data-lset-section"),
    ),
  ).toEqual(["limits"]);
  expect(limits.scrolled).toEqual(["limits"]);
  await limits.close();

  const station = await mount({ search: "&section=stations&station=verify" });
  const slot = station.container.querySelector("[data-stations-slot]");
  expectPresent(slot);
  expect(slot.getAttribute("data-focus-station")).toBe("verify");
  expectAbsent(station.container.querySelector("[data-lset-target]"));
  expect(station.scrolled).toEqual([]);
  await station.close();
});
