import { api } from "@codecast/convex/convex/_generated/api";
import { LINK_DEFAULTS } from "@codecast/convex/convex/lib/slackMirror";
import * as Sentry from "@sentry/react";
import { expect, spyOn, test } from "bun:test";
import type { FunctionReturnType } from "convex/server";
import { act, type ComponentProps } from "react";
import type { ChatSlackLinkRow } from "../../store/chatSlice";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { waitForDom } from "../../test-helpers/waitForDom";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import { ChatComposer } from "./ChatComposer";

const { teamMember } = webBuilders("ChatComposer.slack.mount.test.tsx");
const viewer = teamMember.build({ name: "Samvit" });
const otherViewer = teamMember.build({ name: "Ashot" });
const draftText = "Draft survives authorization";
const firstUrl = "https://slack.com/oauth/v2/authorize?test=1";
const secondUrl = "https://slack.com/oauth/v2/authorize?test=2";

test("Slack composer authorization preserves drafts and enables delivery", async () => {
  let link: ChatSlackLinkRow = {
    _id: "link",
    team_id: "team",
    installation_id: "installation",
    workspace_id: "workspace",
    slack_channel_id: "slack-dm",
    chat_channel_id: "dm",
    kind: "dm",
    direction: "both",
    options: LINK_DEFAULTS,
    viewer_user_id: viewer._id,
    viewer_slack_auth: "connect",
    since_ts: "0",
    created_by: viewer._id,
    created_at: 1,
    updated_at: 1,
  };
  const otherLink: ChatSlackLinkRow = {
    ...link,
    _id: "other-link",
    chat_channel_id: "other-dm",
    viewer_slack_auth: "ready",
  };
  const sent: Parameters<ComponentProps<typeof ChatComposer>["onSend"]>[] = [];
  const opened: string[] = [];
  const captured = spyOn(Sentry, "captureException");

  const composer = (threadRootId?: string) => (
    <ChatComposer
      channelId={link.chat_channel_id}
      teamId={link.team_id}
      threadRootId={threadRootId}
      placeholder="Message Samvit"
      onSend={(...args) => {
        sent.push(args);
      }}
    />
  );

  try {
    const { backend, close, rerender, store } = await mountWeb(
      composer("root"),
      {
        path: "/chat/dm?m=root",
        dispatch: true,
        expectedConsoleErrors: [
          /\[CONVEX A\(slack:getInstallUrl\)\] Error: offline/,
        ],
        setup(backend, store) {
          store.syncTable("currentUser", viewer);
          store.syncTable("chatSlackLinks", [otherLink, link]);
          window.open = (url) => {
            opened.push(String(url));
            return null;
          };
          backend.action(api.slack.getInstallUrl, { ok: true, url: firstUrl });
          backend.mutation(api.dispatch.dispatch, null);
        },
      },
    );

    const checkbox = () =>
      document.querySelector<HTMLInputElement>(
        ".ch-composer-choice:not([data-hand-choice]) input",
      );
    const options = () =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Message options"]',
      )!;
    const button = () =>
      document.querySelector<HTMLButtonElement>(".ch-slack-connect-button")!;
    const textarea = () =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Message Samvit"]',
      )!;
    const changeLink = async (patch: Partial<ChatSlackLinkRow>) => {
      link = { ...link, ...patch, updated_at: link.updated_at + 1 };
      await act(() =>
        store.getState().syncTable("chatSlackLinks", [otherLink, link]),
      );
    };
    const click = (element: HTMLElement) => act(async () => element.click());
    const openOptions = () => click(options());
    const closeOptions = async () => {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      await waitForPopupClose();
    };
    const type = (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(textarea(), text);
        textarea().dispatchEvent(new Event("input", { bubbles: true }));
      });
    const send = () =>
      act(async () => {
        textarea().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });

    expect(document.body.textContent).toContain(
      "Your messages stay in Codecast",
    );
    await openOptions();
    expect(checkbox()?.checked).toBe(false);
    expect(checkbox()?.disabled).toBe(true);
    await closeOptions();
    await type("Before authorization");
    await send();
    expect(sent[0]).toEqual([
      "Before authorization",
      undefined,
      { syncLocalOnly: true },
    ]);
    const draft = textarea();
    await type(draftText);
    await click(button());
    expect(backend.actions[0]).toEqual({
      name: "slack:getInstallUrl",
      args: {
        scope_type: "self",
        team_id: link.team_id,
        return_to: "/chat/dm?m=root",
        origin: "https://app.test",
      },
    });
    expect(opened).toEqual([firstUrl]);
    expect(document.body.textContent).toContain("Finish connecting in Slack");
    expect(textarea()).toBe(draft);
    expect(draft.value).toBe(draftText);

    await changeLink({ viewer_slack_auth: "ready" });
    await act(() =>
      waitForDom(
        document.body,
        () => !document.querySelector(".ch-slack-connect"),
      ),
    );
    expectAbsent(document.querySelector(".ch-slack-connect"));
    await openOptions();
    expect(checkbox()?.disabled).toBe(false);
    expect(checkbox()?.checked).toBe(true);
    expect(checkbox()?.parentElement?.textContent).toMatch(
      /Also send to Slack$/,
    );
    await closeOptions();
    expect(textarea()).toBe(draft);
    await send();
    expect(sent[1]).toEqual([draftText, undefined, undefined]);
    await openOptions();
    await click(checkbox()!);
    await closeOptions();
    await type("Keep this message in Codecast");
    await send();
    expect(sent[2]).toEqual([
      "Keep this message in Codecast",
      undefined,
      { syncLocalOnly: true },
    ]);
    await openOptions();
    expect(checkbox()?.checked).toBe(true);
    await closeOptions();

    await changeLink({ viewer_slack_auth: "reconnect" });
    await rerender(composer());
    expect(document.body.textContent).toContain(
      "Slack needs permission to send as you",
    );
    expect(button().textContent).toBe("Allow replies");
    backend.action(api.slack.getInstallUrl, new Error("offline"));
    await click(button());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t open Slack",
    );
    expect(captured).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([firstUrl]);

    const retry =
      Promise.withResolvers<
        FunctionReturnType<typeof api.slack.getInstallUrl>
      >();
    backend.action(api.slack.getInstallUrl, () => retry.promise);
    await act(async () => {
      button().click();
      button().click();
    });
    expect(button().disabled).toBe(true);
    expect(backend.actions).toHaveLength(3);
    await act(async () => retry.resolve({ ok: true, url: secondUrl }));
    expect(button().disabled).toBe(false);
    expect(opened).toEqual([firstUrl, secondUrl]);
    expectAbsent(document.querySelector('[role="alert"]'));

    await changeLink({
      viewer_user_id: otherViewer._id,
      viewer_slack_auth: "ready",
    });
    await act(() =>
      waitForDom(
        document.body,
        () =>
          !!document.body.textContent?.includes(
            "Checking your Slack connection",
          ),
      ),
    );
    expect(document.body.textContent).toContain(
      "Checking your Slack connection",
    );
    await openOptions();
    expect(checkbox()?.checked).toBe(false);
    expect(checkbox()?.disabled).toBe(true);
    await closeOptions();
    await type("Another person's authorization");
    await send();
    expect(sent.at(-1)).toEqual([
      "Another person's authorization",
      undefined,
      { syncLocalOnly: true },
    ]);

    await changeLink({ kind: "channel", slack_channel_name: "testing" });
    await openOptions();
    await act(() =>
      waitForDom(
        document.body,
        () =>
          checkbox()?.parentElement?.textContent?.includes("Slack #testing") ===
          true,
      ),
    );
    const choice = checkbox();
    expectPresent(choice);
    expect(choice.checked).toBe(true);
    expect(choice.parentElement?.textContent).toContain(
      "Also send to Slack #testing",
    );
    await changeLink({ paused: true });
    await act(() => waitForDom(document.body, () => checkbox() === null));
    expectAbsent(document.querySelector(".ch-slack-connect"));
    expectAbsent(checkbox());
    await closeOptions();
    await close();
  } finally {
    captured.mockRestore();
  }
});
