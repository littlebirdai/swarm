import { afterEach } from "bun:test";
import { ConvexProvider } from "convex/react";
import { act, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast, Toaster } from "sonner";
import { createTestDom } from "./testDom";
import { testConvex } from "./testConvex";

type Store = typeof import("../store/inboxStore").useInboxStore;
type Options = {
  path?: string;
  route?: string;
  setup?: (
    backend: ReturnType<typeof testConvex>,
    store: ReturnType<Store["getState"]>,
  ) => void;
};

let activeMount:
  | { dispose: () => Promise<void>; close: () => Promise<void> }
  | undefined;

afterEach(async () => {
  await activeMount?.close();
});

export async function mountWeb(node: ReactNode, options: Options = {}) {
  if (activeMount)
    throw new Error("Close the active web mount before mounting another.");
  const path = options.path ?? "/";
  const env = createTestDom(new URL(path, "https://app.test").href);
  const backend = testConvex();
  const errors: unknown[] = [];
  let root:
    | ReturnType<typeof import("react-dom/client").createRoot>
    | undefined;
  let resetStore: (() => void) | undefined;

  const dispose = async () => {
    if (activeMount?.dispose !== dispose) return;
    try {
      await act(async () => {
        root?.unmount();
      });
    } finally {
      try {
        await backend.client.close();
        toast.dismiss();
        resetStore?.();
      } finally {
        env.close();
        activeMount = undefined;
      }
    }
  };
  const check = () => {
    backend.assertRegistered();
    if (errors.length) throw new AggregateError(errors, "Web mount failed");
  };
  const close = async () => {
    await dispose();
    check();
  };
  activeMount = { dispose, close };

  try {
    const { createRoot } = await import("react-dom/client");
    const { clearProtectedInboxMemory, useInboxStore } =
      await import("../store/inboxStore");
    const { _resetRememberedResults } =
      await import("../hooks/useQueryNoThrow");
    resetStore = () => {
      clearProtectedInboxMemory();
      _resetRememberedResults();
    };
    resetStore();
    options.setup?.(backend, useInboxStore.getState());
    const container = env.dom.window.document.getElementById("root");
    if (!container) throw new Error("The test DOM has no root element");
    const mounted = createRoot(container, {
      onUncaughtError: (error) => errors.push(error),
    });
    root = mounted;
    const rerender = (next: ReactNode) =>
      act(async () => {
        mounted.render(
          <ConvexProvider client={backend.client}>
            <MemoryRouter initialEntries={[path]}>
              {options.route ? (
                <Routes>
                  <Route path={options.route} element={next} />
                </Routes>
              ) : (
                next
              )}
              <Toaster duration={Infinity} />
            </MemoryRouter>
          </ConvexProvider>,
        );
      });

    await rerender(node);
    check();

    return {
      backend,
      container,
      dom: env.dom,
      store: useInboxStore,
      rerender,
      close,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Web mount and cleanup failed",
      );
    }
    throw error;
  }
}
