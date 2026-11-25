import { ConvexProvider, ConvexProviderWithAuth } from "convex/react";
import { act, useLayoutEffect, type ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router";
import { format } from "node:util";
import { toast, Toaster } from "sonner";
import { replaceGlobals } from "./globals";
import { createTestDom } from "./testDom";
import { trackTestTimers } from "./testTimers";
import { testConvex } from "./testConvex";
import { webMountLifecycle } from "./webMountLifecycle";

type Store = typeof import("../store/inboxStore").useInboxStore;
type StoreState = ReturnType<Store["getState"]>;
type Options = {
  path?: string;
  route?: string;
  authenticated?: boolean;
  dispatch?: boolean;
  expectedConsoleErrors?: readonly RegExp[];
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

type Navigation = { path: string; action: "push" | "replace" | "pop" };

function NavigationLog({ entries }: { entries: Navigation[] }) {
  const location = useLocation();
  const type = useNavigationType();
  useLayoutEffect(() => {
    entries.push({
      path: location.pathname + location.search + location.hash,
      action: type === "PUSH" ? "push" : type === "REPLACE" ? "replace" : "pop",
    });
  }, [entries, location, type]);
  return null;
}

export async function mountWeb(node: ReactNode, options: Options = {}) {
  if (webMountLifecycle.active)
    throw new Error("Close the active web mount before mounting another.");
  const path = options.path ?? "/";
  const env = createTestDom(new URL(path, "https://app.test").href);
  const timers = trackTestTimers();
  const backend = testConvex();
  const errors: unknown[] = [];
  const navigationLog: Navigation[] = [];
  const expectedConsoleErrors = [...(options.expectedConsoleErrors ?? [])];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    const message = format(...args);
    const expected = expectedConsoleErrors.findIndex((pattern) =>
      pattern.test(message),
    );
    if (expected < 0) errors.push(new Error(message));
    else expectedConsoleErrors.splice(expected, 1);
  };
  let root:
    | ReturnType<typeof import("react-dom/client").createRoot>
    | undefined;
  let resetStore: (() => void) | undefined;

  const dispose = async () => {
    if (webMountLifecycle.active?.dispose !== dispose) return;
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
          timers.close();
          console.error = originalConsoleError;
          webMountLifecycle.active = undefined;
        }
      }
    }
  };
  const check = () => {
    backend.assertRegistered();
    if (errors.length)
      throw new AggregateError(
        errors,
        `Web mount failed: ${errors.map(String).join("\n")}`,
      );
  };
  const close = async () => {
    if (webMountLifecycle.active?.dispose !== dispose) return;

    await dispose();
    check();
    if (expectedConsoleErrors.length)
      throw new Error(
        `Missing expected console errors: ${expectedConsoleErrors.join(", ")}`,
      );
  };
  webMountLifecycle.active = { dispose, close };

  try {
    const { createRoot } = await import("react-dom/client");
    const { clearProtectedInboxMemory, useInboxStore } =
      await import("../store/inboxStore");
    const { _resetRememberedResults } =
      await import("../hooks/useQueryNoThrow");
    const { closeCallStage, takeCallThreadRequest } =
      await import("../lib/calls/callStage");
    const { closeReveal } = await import("../lib/revealHost");
    const { askSessionView, settleSessionViewAsk } =
      await import("../lib/sessionViewVisit");
    resetStore = () => {
      const initial = useInboxStore.getInitialState();
      const state = useInboxStore.getState();
      if (Object.keys(state).some((key) => !Object.hasOwn(initial, key))) {
        useInboxStore.setState(
          Object.fromEntries(
            Object.keys(initial).map((key) => [
              key,
              state[key as keyof StoreState],
            ]),
          ) as StoreState,
          true,
        );
      }
      closeCallStage();
      takeCallThreadRequest();
      closeReveal();
      askSessionView("reset");
      settleSessionViewAsk("reset");
      clearProtectedInboxMemory();
      _resetRememberedResults();
    };
    const restoreFrame = replaceGlobals({ requestAnimationFrame: undefined });
    try {
      resetStore();
    } finally {
      restoreFrame();
    }
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
    } else {
      store._setDispatch(async (action) => {
        errors.push(new Error(`Store write with dispatch disabled: ${action}`));
        return null;
      });
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
              <NavigationLog entries={navigationLog} />
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
      pendingTimers: timers.pending,
      navigationLog: navigationLog as readonly Navigation[],
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
