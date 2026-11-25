import { api } from "@codecast/convex/convex/_generated/api";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import * as desktop from "../../../lib/desktop";
import { TabParamsCtx } from "../../../lib/tabParams";
import { useInboxStore } from "../../../store/inboxStore";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { NativeBackend } from "../backends/NativeBackend";
import type { PaneStripAction } from "../backends/types";

const URL_UNDER_TEST = "https://github.com/";
let sent: Array<{
  cmd: desktop.BrowserPaneCommand;
  payload: Record<string, unknown>;
}>;
let available: boolean;
let hasBridge: boolean;
let notifyCapability: (() => void) | undefined;
let deliver: ((event: desktop.BrowserPaneEvent) => void) | undefined;
let restore: () => void;

beforeEach(() => {
  sent = [];
  available = false;
  hasBridge = true;
  const bridge = spyOn(desktop, "browserPaneBridge").mockImplementation(() =>
    hasBridge
      ? {
          send: async (cmd, payload = {}) => {
            sent.push({ cmd, payload });
            return { ok: true };
          },
          on(callback) {
            deliver = callback;
            return () => {
              deliver = undefined;
            };
          },
        }
      : null,
  );
  const capabilities = spyOn(
    desktop,
    "nativeBrowserPaneAvailable",
  ).mockImplementation(() => available);
  const watch = spyOn(desktop, "subscribeNativeBrowserPane").mockImplementation(
    (callback) => {
      notifyCapability = callback;
      return () => {
        notifyCapability = undefined;
      };
    },
  );
  restore = () => {
    bridge.mockRestore();
    capabilities.mockRestore();
    watch.mockRestore();
  };
});

afterEach(() => restore());

async function mount({
  focused = true,
  session,
  withArea = false,
}: {
  focused?: boolean;
  session?: string;
  withArea?: boolean;
} = {}) {
  const actions: PaneStripAction[][] = [];
  const web = await mountWeb(
    <TabParamsCtx.Provider
      value={{
        leafId: "leaf-1",
        tabId: "test-tab",
        pathname: "/browser",
        params: {},
        searchParams: new URLSearchParams(),
        isActive: focused,
      }}
    >
      <NativeBackend
        source={{ kind: "url", url: URL_UNDER_TEST, session }}
        focused={focused}
        reloadToken={0}
        onTitle={() => {}}
        onUrl={() => {}}
        onState={() => {}}
        onActions={(next) => {
          actions.push(next);
        }}
      />
    </TabParamsCtx.Provider>,
    {
      dispatch: true,
      setup(backend) {
        backend.mutation(api.dispatch.dispatch, null);
        useInboxStore.setState({
          activeTabId: "test-tab",
          tabs: [
            {
              id: "test-tab",
              title: "Inbox",
              path: "/inbox",
              createdAt: 0,
              focusedLeafId: "leaf-2",
              layout: {
                type: "split",
                id: "test-split",
                dir: "row",
                sizes: [50, 50],
                children: [
                  { type: "leaf", id: "leaf-1", path: "/browser" },
                  { type: "leaf", id: "leaf-2", path: "/inbox" },
                ],
              },
            },
          ],
        });
        const original = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          return this.hasAttribute("data-native-pane")
            ? withArea
              ? new DOMRect(600, 32, 500, 668)
              : new DOMRect()
            : original.call(this);
        };
      },
    },
  );
  return { ...web, actions };
}

function createdPaneId() {
  const id = sent.find((call) => call.cmd === "create")?.payload.paneId;
  if (typeof id !== "string") throw new Error("The shell received no pane ID");
  return id;
}

const readBounds = async () => {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
};

describe("the native pane before the shell has answered", () => {
  test("asks for nothing while the capability probe is still out", async () => {
    const { container: host, close } = await mount();
    expect(sent).toEqual([]);
    expect(host.textContent).toContain("needs the desktop app");
    expectAbsent(host.querySelector("[data-native-pane]"));
    await close();
  });

  test("asks for nothing when the shell answered that it has no view", async () => {
    available = false;
    const { container: host, close } = await mount();
    expect(sent.map((s) => s.cmd)).toEqual([]);
    expect(host.textContent).toContain("needs the desktop app");
    await close();
  });

  test("puts no back, forward or devtools in the strip it cannot drive", async () => {
    const { actions, close } = await mount();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.length === 0)).toBe(true);
    await close();
  });

  test("a browser tab, with no app IPC at all, is the same quiet", async () => {
    hasBridge = false;
    available = false;
    const { container: host, close } = await mount();
    expect(sent).toEqual([]);
    expect(host.textContent).toContain("needs the desktop app");
    await close();
  });
});

describe("once the shell answers that it has the view", () => {
  test("the pane creates it, at the address the route named", async () => {
    available = true;
    const { container: host, close } = await mount();
    const create = sent.find((s) => s.cmd === "create");
    expect(create).toBeDefined();
    expect(create!.payload.url).toBe(URL_UNDER_TEST);
    expect(create!.payload.visible).toBe(false);
    expectPresent(host.querySelector("[data-native-pane]"));
    await close();
  });

  test("the create names the offering session, so the shell's registry knows who may drive the view", async () => {
    available = true;
    const session = "509b4b48-c521-4352-bf19-eafa153745bb";
    const { close } = await mount({ session });
    const create = sent.find((s) => s.cmd === "create");
    expect(create).toBeDefined();
    expect(create!.payload.session).toBe(session);
    await close();
    sent = [];
    const bare = await mount();
    expect(
      sent.find((s) => s.cmd === "create")!.payload.session,
    ).toBeUndefined();
    await bare.close();
  });

  test("an answer that lands after mount still opens the view", async () => {
    const { close } = await mount();
    expect(sent).toEqual([]);
    available = true;
    await act(async () => notifyCapability?.());
    expect(sent.map((s) => s.cmd)).toContain("create");
    await close();
  });

  test("the verbs appear only with a view to drive", async () => {
    available = true;
    const { actions, close } = await mount();
    const last = actions.at(-1)!;
    expect(last.map((a) => a.label)).toEqual([
      "Back to the previous page",
      "Forward to the next page",
      "Open developer tools for this pane",
    ]);
    await close();
  });

  test("unmounting takes the view down with it", async () => {
    available = true;
    const { close } = await mount();
    sent = [];
    await close();
    expect(sent.map((s) => s.cmd)).toContain("destroy");
  });
});

describe("a native pane that is on screen but not focused", () => {
  test("stays shown, because the person is reading it beside their work", async () => {
    available = true;
    const { close } = await mount({ focused: false, withArea: true });
    await readBounds();
    expect(
      sent.findLast((call) => call.cmd === "bounds")?.payload.visible,
    ).toBe(true);
    await close();
  });

  test("a pane with no area is hidden, which is how a background tab hides", async () => {
    available = true;
    const { close } = await mount({ focused: true });
    await readBounds();
    expect(
      sent.findLast((call) => call.cmd === "bounds")?.payload.visible,
    ).toBe(false);
    await close();
  });
});

describe("keys the page was not allowed to keep", () => {
  test("come back as the app's own keystroke, so the palette still opens", async () => {
    available = true;
    const { close } = await mount();
    const seen: Array<{ key: string; meta: boolean; ctrl: boolean }> = [];
    const onKey = (e: KeyboardEvent) =>
      seen.push({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey });
    window.addEventListener("keydown", onKey, true);
    try {
      expect(deliver).not.toBeNull();
      await act(async () => {
        deliver!({
          paneId: createdPaneId(),
          event: "chord",
          key: "k",
        });
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].key).toBe("k");
      expect(seen[0].meta || seen[0].ctrl).toBe(true);
      expect(seen[0].meta && seen[0].ctrl).toBe(false);
    } finally {
      window.removeEventListener("keydown", onKey, true);
      await close();
    }
  });

  test("reload is the pane's own: it goes to the view, not to the app", async () => {
    available = true;
    const { close } = await mount();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey, true);
    try {
      const paneId = createdPaneId();
      sent = [];
      await act(async () => {
        deliver!({ paneId, event: "chord", key: "r" });
      });
      expect(seen).toEqual([]);
      expect(sent.map((s) => s.cmd)).toContain("reload");
    } finally {
      window.removeEventListener("keydown", onKey, true);
      await close();
    }
  });
});

describe("a click inside the page", () => {
  test("moves the stage's focus ring to this pane", async () => {
    available = true;
    const { close, store } = await mount();
    const focus = () => store.getState().tabs[0].focusedLeafId;
    expect(focus()).toBe("leaf-2");
    await act(async () => {
      deliver!({ paneId: "someone-else", event: "focus" });
    });
    expect(focus()).toBe("leaf-2");
    await act(async () => {
      deliver!({ paneId: createdPaneId(), event: "focus" });
    });
    expect(focus()).toBe("leaf-1");
    await close();
  });
});
