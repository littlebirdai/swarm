import { afterEach } from "bun:test";
import { ConvexProvider, ConvexProviderWithAuth } from "convex/react";
import { act, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast, Toaster } from "sonner";
import { createTestDom } from "./testDom";
import { trackTestTimers } from "./testTimers";
import { testConvex } from "./testConvex";

type Store = typeof import("../store/inboxStore").useInboxStore;
type Options = {
  path?: string;
  route?: string;
  authenticated?: boolean;
  dispatch?: boolean;
  setup?: (
    backend: ReturnType<typeof testConvex>,
    store: ReturnType<Store["getState"]>,
  ) => void;
};

const testAuth = {
  isLoading: false,
  isAuthenticated: true,
  fetchAccessToken: async () => {
    const claims = Buffer.from(JSON.stringify({ iat: 1, exp: 3601 })).toString(
      "base64url",
    );
    return `eyJhbGciOiJIUzI1NiJ9.${claims}.test`;
  },
};

function useTestAuth() {
  return testAuth;
}

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
  const restoreTimers = trackTestTimers();
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
        try {
          env.close();
        } finally {
          restoreTimers();
          activeMount = undefined;
        }
      }
    }
  };
  const check = () => {
    backend.assertRegistered();
    if (errors.length) throw new AggregateError(errors, "Web mount failed");
  };
  const close = async () => {
    if (activeMount?.dispose !== dispose) return;

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
    const store = useInboxStore.getState();
    if (options.dispatch) {
      const { api } = await import("@codecast/convex/convex/_generated/api");
      const { applyDispatchFailure, makeDispatchBinding } =
        await import("../lib/dispatchBinding");
      store._setDispatchError(applyDispatchFailure);
      store._setDispatch(
        makeDispatchBinding((args) =>
          backend.client.mutation(api.dispatch.dispatch, args),
        ),
      );
    }
    options.setup?.(backend, store);
    const container = env.dom.window.document.getElementById("root");
    if (!container) throw new Error("The test DOM has no root element");
    const mounted = createRoot(container, {
      onUncaughtError: (error) => errors.push(error),
    });
    root = mounted;
    const Provider = options.authenticated
      ? ConvexProviderWithAuth
      : ConvexProvider;
    const rerender = (next: ReactNode) =>
      act(async () => {
        mounted.render(
          <Provider client={backend.client} useAuth={useTestAuth}>
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
          </Provider>,
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
