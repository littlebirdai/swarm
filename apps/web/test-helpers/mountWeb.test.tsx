import { ConvexError } from "convex/values";
import {
  getCallStageOpen,
  openCallStage,
  requestCallThread,
  takeCallThreadRequest,
} from "../lib/calls/callStage";
import { currentReveal, toggleReveal } from "../lib/revealHost";
import { askSessionView, sessionViewAskFor } from "../lib/sessionViewVisit";
import { webBuilders } from "./builders";
import { expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useSyncCollection } from "../hooks/useSyncCollection";
import { mountWeb } from "./mountWeb";
import { pending } from "./testConvex";
import { waitForDom } from "./waitForDom";

const getLabel = makeFunctionReference<"query", { id: string }, string>(
  "test:label",
);
const getDocs = makeFunctionReference<
  "query",
  Record<string, never>,
  { _id: string; title: string }[]
>("test:docs");
const save = makeFunctionReference<"mutation", { label: string }, string>(
  "test:save",
);
const exportDoc = makeFunctionReference<"action", { id: string }, string>(
  "test:export",
);

function Label({ id }: { id: string }) {
  const { data, error } = useQueryNoThrow(getLabel, { id });
  return <span>{error?.message ?? data ?? "Waiting"}</span>;
}

test("delivers pending, argument-specific values, errors, and recovery to real query hooks", async () => {
  const { backend, container } = await mountWeb(
    <>
      <Label id="First" />
      <Label id="Second" />
    </>,
    {
      setup: (backend) => backend.set(getLabel, pending),
    },
  );
  const labels = () =>
    [...container.querySelectorAll("span")].map((span) => span.textContent);
  expect(labels()).toEqual(["Waiting", "Waiting"]);
  await act(async () => backend.set(getLabel, ({ id }) => id));
  expect(labels()).toEqual(["First", "Second"]);
  await act(async () =>
    backend.set(getLabel, new Error("Server rejected the query")),
  );
  expect(labels()[0]).toContain("Server rejected the query");
  await act(async () => backend.set(getLabel, "Recovered"));
  expect(labels()).toEqual(["Recovered", "Recovered"]);
});

test("rejects an unregistered query with its name even if the component handles the error", async () => {
  await expect(mountWeb(<Label id="First" />)).rejects.toThrow(
    "Unregistered Convex query: test:label",
  );
});

test("feeds the real store and resets it when the mount closes", async () => {
  function Feed() {
    const { ready } = useSyncCollection("docs", getDocs, {});
    return <p>{ready ? "Ready" : "Waiting"}</p>;
  }

  const previousDocument = globalThis.document;
  const { backend, store, container, close } = await mountWeb(<Feed />, {
    setup: (backend, store) => {
      backend.set(getDocs, pending);
      store.syncTable("docs", [{ _id: "cached", title: "Cached" }]);
    },
  });
  expect(store.getState().docs.cached?.title).toBe("Cached");
  expect(container.textContent).toBe("Waiting");
  await act(async () => backend.set(getDocs, [{ _id: "live", title: "Live" }]));
  expect(container.textContent).toBe("Ready");
  expect(store.getState().docs.live?.title).toBe("Live");
  await close();
  expect(store.getState().docs).toEqual({});
  expect(container.childElementCount).toBe(0);
  expect(globalThis.document).toBe(previousDocument);
});

test("records writes, shows a toast, and follows the real Link shim", async () => {
  function Form() {
    const mutate = useMutation(save);
    const run = useAction(exportDoc);
    const path = usePathname();
    const router = useRouter();
    return (
      <>
        <Link href="/destination">Open</Link>
        <p>{path}</p>
        <button data-back onClick={router.back}>
          Back
        </button>
        <button
          data-save
          onClick={async () => {
            const label = await mutate({ label: "Draft" });
            const url = await run({ id: label });
            toast.success(url);
          }}
        >
          Save
        </button>
      </>
    );
  }

  const { backend, container, navigationLog } = await mountWeb(<Form />, {
    setup: (backend) => {
      backend.mutation(save, ({ label }) => `${label} saved`);
      backend.action(exportDoc, ({ id }) => `${id} and exported`);
    },
  });
  await act(async () => container.querySelector("a")?.click());
  expect(container.querySelector("p")?.textContent).toBe("/destination");
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-back]")?.click(),
  );
  expect(navigationLog).toEqual([
    { path: "/", action: "pop" },
    { path: "/destination", action: "push" },
    { path: "/", action: "pop" },
  ]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-save]")?.click(),
  );
  expect(backend.mutations).toEqual([
    { name: "test:save", args: { label: "Draft" } },
  ]);
  expect(backend.actions).toEqual([
    { name: "test:export", args: { id: "Draft saved" } },
  ]);
  await act(async () =>
    waitForDom(
      container,
      () => !!container.querySelector("[data-sonner-toast]"),
    ),
  );
  expect(container.querySelector("[data-sonner-toast]")?.textContent).toBe(
    "Draft saved and exported",
  );
});

test("reports unregistered writes by name even when their callers catch them", async () => {
  const { backend, close } = await mountWeb(null);
  await expect(
    backend.client.mutation(save, { label: "Draft" }),
  ).rejects.toThrow("Unregistered Convex mutation: test:save");
  await expect(
    backend.client.action(exportDoc, { id: "draft" }),
  ).rejects.toThrow("Unregistered Convex action: test:export");
  await expect(close()).rejects.toThrow(
    "Unregistered Convex mutation: test:save\nUnregistered Convex action: test:export",
  );
});

test("reports a store write by action name when dispatch is disabled", async () => {
  const { store, close } = await mountWeb(null);
  await act(async () => store.getState().touchMru("test-session"));
  await expect(close()).rejects.toThrow(
    "Store write with dispatch disabled: touchMru",
  );
});

test("answers null when a query handler returns undefined", async () => {
  const { backend } = await mountWeb(null, {
    setup: (backend) => backend.set(getLabel, () => undefined),
  });
  expect(await backend.client.query(getLabel, { id: "missing" })).toBeNull();
}, 1500);

test("delivers ConvexError data on queries, mutations and actions", async () => {
  const data = {
    reason: "draft is locked",
    retryable: false,
    payload: BigInt(3),
  };
  const failure = () => {
    throw new ConvexError(data);
  };
  const { backend } = await mountWeb(null, {
    expectedConsoleErrors: [
      /CONVEX M\(test:save\).*draft is locked/,
      /CONVEX A\(test:export\).*draft is locked/,
    ],
    setup: (backend) => {
      backend.set(getLabel, failure);
      backend.mutation(save, new ConvexError(data));
      backend.action(exportDoc, async () => failure());
    },
  });
  for (const request of [
    () => backend.client.query(getLabel, { id: "draft" }),
    () => backend.client.mutation(save, { label: "Draft" }),
    () => backend.client.action(exportDoc, { id: "draft" }),
  ]) {
    const write = request();
    await expect(write).rejects.toBeInstanceOf(ConvexError);
    await expect(write).rejects.toMatchObject({ data });
  }
});

function MissingListKeys({ labels }: { labels: string[] }) {
  const items = labels.map((label) => createElement("li", null, label));
  return createElement("ul", null, items);
}

test("rejects a React console error unless the test expects it", async () => {
  await expect(
    mountWeb(<MissingListKeys labels={["Draft", "Published"]} />),
  ).rejects.toThrow("Each child in a list should have a unique");
  const { close } = await mountWeb(null, {
    expectedConsoleErrors: [/expected application error/],
  });
  console.error("expected application error");
  await close();
});

test("rejects a console error after the initial render", async () => {
  const { close } = await mountWeb(null);
  console.error("late application error");
  await expect(close()).rejects.toThrow("late application error");
});

test("reports a React update outside act", async () => {
  function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>{count}</button>;
  }
  const { container, close } = await mountWeb(<Counter />);
  container.querySelector("button")?.click();
  await expect(close()).rejects.toThrow(
    "An update to Counter inside a test was not wrapped in act",
  );
});

test("clears added store keys and shared view state", async () => {
  const { store, close } = await mountWeb(null);
  const extra = { ...store.getState(), stray: "previous test" };
  store.setState(extra, true);
  askSessionView("unopened-seat");
  openCallStage();
  requestCallThread();
  const anchor = document.createElement("button");
  document.body.append(anchor);
  toggleReveal("test-host", { href: "/tasks/ct-1", title: "Draft" }, anchor);
  await close();
  expect(Object.hasOwn(store.getState(), "stray")).toBe(false);
  expect(sessionViewAskFor("unopened-seat")).toBe(null);
  expect(getCallStageOpen()).toBe(false);
  expect(takeCallThreadRequest()).toBe(false);
  expect(currentReveal() === null).toBe(true);
});

test("short IDs increase across the entity builders", () => {
  const fixtures = webBuilders("fixture-id-proof");
  const ids = [
    fixtures.task.build().short_id,
    fixtures.project.build().short_id,
    fixtures.role.build().short_id,
    fixtures.task.build().short_id,
  ];
  expect(ids).toEqual(["ct-1", "pj-2", "ro-3", "ct-4"]);
});

test("reports timers that survive unmount", async () => {
  const { close, pendingTimers } = await mountWeb(null);
  const unused = setTimeout(() => {}, 10_000);
  clearTimeout(unused);
  function backgroundPoll() {}
  setInterval(backgroundPoll, 30_000);
  await close();
  expect(pendingTimers).toContainEqual({
    kind: "interval",
    delay: 30_000,
    callback: "backgroundPoll",
  });
  expect(pendingTimers.some(({ delay }) => delay === 10_000)).toBe(false);
});

test("restores store actions and accepts browser calls that jsdom lacks", async () => {
  const { useInboxStore } = await import("../store/inboxStore");
  const original = useInboxStore.getInitialState().touchMru;
  const first = await mountWeb(null);
  useInboxStore.setState({ touchMru: () => {} });
  window.open("/docs");
  document.createElement("canvas").getContext("2d");
  await first.close();
  const second = await mountWeb(null);
  expect(useInboxStore.getState().touchMru).toBe(original);
  await second.close();
});
