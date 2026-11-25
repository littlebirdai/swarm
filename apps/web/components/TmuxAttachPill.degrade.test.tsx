import { describe, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { act, type ReactElement } from "react";
import { expectAbsent, expectPresent } from "../test-helpers/domExpect";
import { expectEmptyMount } from "../test-helpers/expectEmptyMount";
import { expectToast } from "../test-helpers/expectToast";
import { mountWeb } from "../test-helpers/mountWeb";
import { pending } from "../test-helpers/testConvex";
import { waitForDom } from "../test-helpers/waitForDom";
import { TmuxAttachPill } from "./TmuxAttachPill";

const missingFunction = new Error(
  "[Request ID: e460f7bdf61343dc] Server Error\nCould not find public function for 'devices:getConversationMachine'.",
);
const foreignMachine = {
  device_id: "965fa002dd353cd5",
  label: "macOS - Mac-mini",
  platform: "darwin",
  is_remote: false,
  is_mine: false,
  via_bot: false,
  last_seen: Date.now(),
  ssh_host: null,
  wsl_distro: null,
};
const conversationKey = "jx7fata";
const copySelector = '[aria-label="Copy tmux attach command"]';
const pane = (
  <TmuxAttachPill
    tmuxSession="cc-resume-7ea05201"
    isLive
    conversationKey={conversationKey}
  />
);

async function mount(
  node: ReactElement,
  answer: typeof pending | Error | typeof foreignMachine = pending,
) {
  const copied: string[] = [];
  const web = await mountWeb(node, {
    setup(backend) {
      backend.set(api.devices.getConversationMachine, answer);
      Object.defineProperty(navigator, "clipboard", {
        value: {
          async writeText(text: string) {
            copied.push(text);
          },
        },
      });
    },
  });
  return { ...web, copied };
}

describe("TmuxAttachPill under a backend that lacks the query", () => {
  test("Codex without a pane has a focusable gray explanation and no attach action", async () => {
    const web = await mount(
      <TmuxAttachPill agentType="codex" isLive conversationKey="cx-server" />,
    );
    const help = web.container.querySelector<HTMLButtonElement>(
      '[aria-label="No tmux terminal attached"]',
    );
    expectPresent(help);
    expect(help.getAttribute("aria-disabled")).toBe("true");
    expect(help.disabled).toBe(false);
    expect(help.className).toContain("text-gray-400");
    expectAbsent(web.container.querySelector('[class*="text-sol-green"]'));
    expectAbsent(web.container.querySelector(copySelector));
    expect(web.backend.queryRequests).toEqual([]);
    await web.close();
  });

  test("other agents without a pane still omit the pill", async () => {
    const web = await mount(<TmuxAttachPill agentType="claude" isLive />);
    expectEmptyMount(web.container);
    await web.close();
  });

  test("Codex with a pane retains the terminal and copy actions", async () => {
    const web = await mount(
      <TmuxAttachPill
        agentType="codex"
        tmuxSession="cx-resume"
        isLive
        conversationKey="cx-tmux"
      />,
    );
    const copy = web.container.querySelector(copySelector);
    expectPresent(copy);
    expect(copy.className).toContain("text-sol-green");
    expectAbsent(
      web.container.querySelector('[aria-label="No tmux terminal attached"]'),
    );
    expect(web.backend.queryRequests).toEqual([
      {
        name: "devices:getConversationMachine",
        args: { conversation_id: "cx-tmux" },
      },
    ]);
    await web.close();
  });

  test("keeps a local pane and its copy action when the machine query fails", async () => {
    const web = await mount(pane, missingFunction);
    expect(web.backend.queryRequests).toEqual([
      {
        name: "devices:getConversationMachine",
        args: { conversation_id: conversationKey },
      },
    ]);
    const primary = web.container.querySelector("button");
    expectPresent(primary);
    expect(primary.textContent).toBe("tmux");
    expect(primary.getAttribute("aria-disabled")).toBe("false");
    expectAbsent(web.container.querySelector('[aria-disabled="true"]'));
    const copy = web.container.querySelector<HTMLButtonElement>(copySelector);
    expectPresent(copy);
    expect(copy.getAttribute("aria-disabled")).toBe("false");
    expectAbsent(web.container.querySelector("[data-simple-hide]"));
    await act(async () => copy.click());
    await expectToast("success", "tmux attach copied");
    expect(web.copied).toEqual([
      "tmux -L 'cast-cc-resume-7ea05201' attach -t 'cc-resume-7ea05201' 2>/dev/null || tmux attach -t 'cc-resume-7ea05201'",
    ]);
    await web.close();
  });

  test("a resolved machine still names it and withholds the command", async () => {
    const web = await mount(pane, foreignMachine);
    await act(() =>
      waitForDom(
        web.container,
        () => web.container.textContent?.includes("Mac-mini") === true,
      ),
    );
    expect(web.container.querySelector("button")?.textContent).toContain(
      "Mac-mini",
    );
    expectAbsent(web.container.querySelector(copySelector));
    await web.close();
  });
});
