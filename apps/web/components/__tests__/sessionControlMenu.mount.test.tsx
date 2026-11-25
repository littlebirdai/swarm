import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { act, useState } from "react";
import type { InboxSession } from "../../store/inboxStore";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { expectToast } from "../../test-helpers/expectToast";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import {
  SessionControlPanel,
  type SessionControlPanelProps,
} from "../SessionControlMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const builders = webBuilders("sessionControlMenu.mount.test.tsx");
const session = builders.session.build({
  model: "claude-opus-4-8",
  effort: "high",
  message_count: 12,
});
const handoffConversation = builders.conversation.build({
  short_id: "jx7new1",
  agent_type: "codex",
});
const forkedConversation = builders.conversation.build({ agent_type: "codex" });
const forkSessionId = builders.session.build().session_id as ReturnType<
  typeof crypto.randomUUID
>;
const viewer = builders.teamMember.build();

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(selector),
];
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });

async function mount(
  props: Partial<SessionControlPanelProps> = {},
  options: {
    fields?: Partial<InboxSession>;
    pinnedAgents?: string[];
    refused?: boolean;
  } = {},
) {
  const closes: number[] = [];
  function OpenMenu() {
    const [open, setOpen] = useState(true);
    return (
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger>badge</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SessionControlPanel
            conversationId={session._id}
            agentType="claude_code"
            model="claude-opus-4-8"
            effort="high"
            messageCount={12}
            onModelSelect={() => {}}
            onClose={() => {
              closes.push(1);
              setOpen(false);
            }}
            {...props}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const web = await mountWeb(<OpenMenu />, {
    dispatch: true,
    setup(backend, store) {
      const now = Date.now();
      store.syncTable("currentUser", {
        ...viewer,
        default_models: {},
        pinned_agents: options.pinnedAgents,
      });
      store.syncTable("sessions", [
        {
          ...session,
          started_at: now,
          updated_at: now,
          last_heartbeat: now,
          agent_status_updated_at: now,
          is_connected: true,
          ...options.fields,
        },
      ]);
      if (options.refused)
        store.syncTable("sessionCommands", [
          {
            _id: "refused-sdk",
            conversation_id: session._id,
            kind: "backend",
            backend: "sdk",
            command: "switch_claude_backend",
            requested_at: now - 2000,
            executed_at: now - 1000,
            result: null,
            error:
              "Stays in the terminal: Claude Code 2.0.1 is older than 2.1.248",
          },
        ]);
      backend.set(api.devices.listDevices, []);
      backend.mutation(api.dispatch.dispatch, ({ action, args }) => {
        if (action === "convCommand" && args[1] === "forkFromMessage") {
          return { conversation_id: forkedConversation._id };
        }
        return null;
      });
      backend.action(api.handoff.start, {
        source: {
          conversation_id: session._id as typeof handoffConversation._id,
          title: session.title ?? null,
          short_id: "jx7source",
          agent_type: session.agent_type,
          model: session.model ?? null,
          message_count: 12,
          task_short_id: null,
          project_path: null,
          plan_short_id: null,
        },
        prompt: "",
        brief: "",
        brief_source: "fallback",
        session: {
          conversation_id: handoffConversation._id,
          short_id: "jx7new1",
          agent_type: "codex",
          model: "gpt-5.5",
          effort: null,
          project_path: null,
        },
      });
    },
  });
  return { ...web, closes };
}

function commands(web: Awaited<ReturnType<typeof mount>>, command: string) {
  return web.backend.mutations.flatMap(({ name, args }) => {
    const body = args as { action?: string; args?: unknown };
    return name === "dispatch:dispatch" && body.action === command
      ? [body.args]
      : [];
  });
}

test("a live claude session: identity line, model rows, effort chips", async () => {
  await mount();
  const panel = q("[data-session-control-panel]")!;
  expect(panel).toBeTruthy();
  expect(q("[data-session-state]")!.textContent).toContain("Live session");
  const text = panel.textContent ?? "";
  for (const label of [
    "Model",
    "Fable",
    "Opus",
    "Sonnet",
    "Haiku",
    "Effort",
    "Move this session",
    "Switch agent",
    "Fork as",
    "Hand off to",
    "seeded with a brief",
  ]) {
    expect(text).toContain(label);
  }
});

const openVerb = (verb: string) => {
  const row = q(`[data-move-row="${verb}"]`)!;
  act(() => {
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
};
const agentRow = (agent: string) =>
  q(`[data-pick-step] [data-agent-row="${agent}"]`)!;
const pickAgent = (agent: string) =>
  act(() => {
    agentRow(agent).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

test("the switch list honors canSessionBecomeAgent: current ringed and inert, cursor inert with its reason, codex switches", async () => {
  const web = await mount();
  expect(
    qa("[data-move-row]").map((r) => r.getAttribute("data-move-row")),
  ).toEqual(["switch", "fork", "handoff"]);
  expectAbsent(q("[data-agent-row]"));

  openVerb("switch");
  expect(q("[data-pick-step]")!.getAttribute("data-pick-step")).toBe("switch");
  const current = agentRow("claude_code");
  expect(current.getAttribute("data-current")).toBe("true");
  expect(current.getAttribute("data-disabled")).not.toBeNull();
  expect(current.textContent).toContain("current");
  const cursor = agentRow("cursor");
  expect(cursor.getAttribute("data-disabled")).not.toBeNull();
  expect(cursor.textContent).toContain("can't rebuild history");
  const codex = agentRow("codex");
  expect(codex.getAttribute("data-disabled")).toBeNull();

  pickAgent("cursor");
  expect(commands(web, "convCommand")).toEqual([]);
  await act(async () => pickAgent("codex"));
  expect(commands(web, "convCommand")).toEqual([
    [session._id, "switchSessionAgent", { agent_type: "codex" }],
  ]);

  await waitForPopupClose();
  await web.close();
  const fork = await mount();
  openVerb("fork");
  expectAbsent(q('[data-pick-step] [data-agent-row="claude_code"]'));
  const random = spyOn(crypto, "randomUUID").mockReturnValueOnce(forkSessionId);
  try {
    await act(async () => pickAgent("codex"));
  } finally {
    random.mockRestore();
  }
  const forked = commands(fork, "convCommand");
  const target = fork.store.getState().pendingNavigateId;
  expect(target).toBe(forkSessionId);
  expect(forked).toEqual([
    [
      session._id,
      "forkFromMessage",
      { target_agent_type: "codex", session_id: forkSessionId },
    ],
  ]);
  expect(
    fork.store.getState().sessions[forkedConversation._id]
      ?.parent_conversation_id,
  ).toBe(session._id);
});

test("the hand-off step shows the chosen agent's models, takes a direction, and calls handoff.start", async () => {
  const web = await mount();
  openVerb("handoff");
  expect(agentRow("claude_code").getAttribute("data-disabled")).toBeNull();
  pickAgent("codex");
  const step = q("[data-handoff-step]")!;
  expect(step.getAttribute("data-handoff-step")).toBe("codex");
  const text = step.textContent ?? "";
  expect(text).toContain("Hand off to");
  expect(text).toContain("Codex");
  expect(text).toContain("GPT-6 Astra");
  expect(text).not.toContain("Sonnet");
  expect(text).toContain("Haiku brief");

  const row = qa("[data-handoff-step] [role=menuitem]").find(
    (el) =>
      el.textContent?.includes("GPT-5.5") && !el.textContent?.includes("Sol"),
  )!;
  click(row);
  expectPresent(q("[data-handoff-step]"));
  expect(q("[data-handoff-submit]")!.textContent).toContain("GPT-5.5");

  const ta = q<HTMLTextAreaElement>("[data-handoff-step] textarea")!;
  expect(ta.placeholder).toContain("do first");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(ta, "Finish the migration test");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => click(q("[data-handoff-submit]")!));
  expect(web.backend.actions).toEqual([
    {
      name: "handoff:start",
      args: {
        conversation_id: session._id,
        agent_type: "codex",
        model: "gpt-5.5",
        direction: "Finish the migration test",
      },
    },
  ]);
  await expectToast("success", "Handed off to jx7new1 on Codex");
  expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
  expect(web.store.getState().pendingNavigateId).toBe(handoffConversation._id);
  expect(web.closes).toHaveLength(1);
  await waitForPopupClose();
  await web.close();
  await mount({}, { pinnedAgents: ["claude_code", "codex", "gemini"] });
  openVerb("handoff");
  pickAgent("gemini");
  expect(q("[data-handoff-step]")!.textContent).toContain(
    "launches with its own configured model",
  );
  click(
    qa("[data-handoff-step] button").find(
      (b) => b.textContent?.trim() === "Back",
    )!,
  );
  expect(q("[data-pick-step]")!.getAttribute("data-pick-step")).toBe("handoff");
  click(
    qa("[data-pick-step] button").find(
      (b) => b.textContent?.trim() === "Back",
    )!,
  );
  expectAbsent(q("[data-pick-step]"));
  expectPresent(q("[data-session-control-panel]"));
});

test("a blank session and an agent with no model rail read their state on the identity line", async () => {
  const blank = await mount({
    messageCount: 0,
    model: undefined,
    effort: undefined,
  });
  expect(q("[data-session-state]")!.textContent).toContain("Blank session");
  expect(q("[data-session-control-panel]")!.textContent).toContain("default");
  openVerb("switch");
  expect(agentRow("cursor").getAttribute("data-disabled")).toBeNull();

  await blank.close();
  await mount({ agentType: "gemini", model: undefined, effort: undefined });
  expect(q("[data-session-state]")!.textContent).toContain(
    "keeps the model it launched with",
  );
  expect(q("[data-session-control-panel]")!.textContent).not.toContain(
    "Effort",
  );
});

const pressBackend = (b: string) => {
  const row = q(`[data-backend-row="${b}"]`)!;
  act(() => {
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
};

test("a live tmux Claude session offers the Agent SDK as a plain switch", async () => {
  const web = await mount(
    {},
    { fields: { agent_status: "idle", claude_backend: null } },
  );
  const rows = qa("[data-backend-row]");
  expect(rows.map((r) => r.getAttribute("data-backend-row"))).toEqual([
    "tmux",
    "sdk",
  ]);
  expect(q('[data-backend-row="tmux"]')!.getAttribute("data-current")).toBe(
    "true",
  );
  expect(q('[data-backend-row="sdk"]')!.textContent).toContain("Never parked");
  await act(async () => pressBackend("sdk"));
  expect(commands(web, "switchClaudeBackend")).toEqual([
    [expect.any(String), session._id, "sdk", false],
  ]);
  expect(q('[data-move-row="fork"]')!.textContent).toContain(
    "on another agent",
  );
});

test("an SDK session mid-turn names the interrupt on the terminal row, and its fork row says the copy opens in a terminal", async () => {
  const web = await mount(
    {},
    { fields: { agent_status: "working", claude_backend: "sdk" } },
  );
  expect(q('[data-backend-row="sdk"]')!.getAttribute("data-current")).toBe(
    "true",
  );
  expect(q('[data-backend-row="tmux"]')!.textContent).toContain(
    "Stop the turn, run in a terminal",
  );
  await act(async () => pressBackend("tmux"));
  expect(commands(web, "switchClaudeBackend")).toEqual([
    [expect.any(String), session._id, "tmux", true],
  ]);
  expect(q('[data-move-row="fork"]')!.textContent).toContain("in a terminal");
});

test("a refused switch says why under the rows; a blank or non-Claude session shows no backend rows", async () => {
  const fields = {
    agent_status: "idle",
    claude_backend: null,
  } satisfies Partial<InboxSession>;
  const refused = await mount({}, { fields, refused: true });
  expect(q("[data-backend-failed]")!.textContent).toContain(
    "older than 2.1.248",
  );
  await refused.close();
  const blank = await mount({ messageCount: 0 }, { fields });
  expectAbsent(q("[data-backend-rows]"));
  await blank.close();
  await mount({ agentType: "codex" }, { fields });
  expectAbsent(q("[data-backend-rows]"));
});
