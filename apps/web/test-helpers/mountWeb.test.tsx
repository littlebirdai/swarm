import { expect, test } from "bun:test";
import { act } from "react";
import { useAction, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useSyncCollection } from "../hooks/useSyncCollection";
import { mountWeb } from "./mountWeb";
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
      setup: (backend) => backend.set(getLabel, undefined),
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
    "Unregistered Convex queries: test:label",
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
      backend.set(getDocs, undefined);
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
    return (
      <>
        <Link href="/destination">Open</Link>
        <p>{path}</p>
        <button
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

  const { backend, container } = await mountWeb(<Form />, {
    setup: (backend) => {
      backend.mutation(save, ({ label }) => `${label} saved`);
      backend.action(exportDoc, ({ id }) => `${id} and exported`);
    },
  });
  await act(async () => container.querySelector("a")?.click());
  expect(container.querySelector("p")?.textContent).toBe("/destination");
  await act(async () => container.querySelector("button")?.click());
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
