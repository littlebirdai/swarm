import { api } from "@codecast/convex/convex/_generated/api";
import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { leavesOf } from "../../store/stageSplit";
import { expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { FrameBackend } from "../browser/backends/FrameBackend";

test("a pane gesture from the framed page lands on this window's stage", async () => {
  const probe = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  try {
    const web = await mountWeb(
      <FrameBackend
        source={{ kind: "url", url: "https://codecast.sh/inbox" }}
        focused
        reloadToken={0}
        onTitle={() => {}}
        onUrl={() => {}}
        onState={() => {}}
      />,
      {
        path: "/inbox",
        dispatch: true,
        setup(backend) {
          backend.mutation(api.dispatch.dispatch, null);
          useInboxStore.setState({
            activeTabId: "inbox-tab",
            tabs: [
              { id: "inbox-tab", path: "/inbox", title: "Inbox", createdAt: 0 },
            ],
          });
        },
      },
    );

    const frame = web.container.querySelector("iframe");
    expectPresent(frame);
    const framed = frame.contentWindow;
    expect(framed).toBeTruthy();

    const paths = () => {
      const { tabs, activeTabId } = web.store.getState();
      return leavesOf(tabs.find((tab) => tab.id === activeTabId)?.layout).map(
        (leaf) => leaf.path,
      );
    };
    const send = (data: unknown, origin: string, sender: unknown) =>
      act(async () => {
        window.dispatchEvent(
          Object.assign(new Event("message"), { data, origin, source: sender }),
        );
      });

    await send(
      {
        type: "codecast:open-pane",
        source: { kind: "url", url: "http://localhost:8765" },
      },
      "https://codecast.sh",
      framed,
    );
    const browserPath = "/browser?u=http%3A%2F%2Flocalhost%3A8765";
    expect(paths()).toEqual(["/inbox", browserPath]);

    await send(
      { type: "codecast:open-beside", path: "/tasks/ct-1" },
      "https://codecast.sh",
      framed,
    );
    expect(paths()).toEqual(["/inbox", browserPath, "/tasks/ct-1"]);

    await send(
      { type: "codecast:open-beside", path: "/docs" },
      "https://codecast.sh",
      window,
    );
    await send(
      { type: "codecast:open-beside", path: "/docs" },
      "https://evil.example",
      framed,
    );
    expect(paths()).toEqual(["/inbox", browserPath, "/tasks/ct-1"]);
  } finally {
    probe.mockRestore();
  }
});
