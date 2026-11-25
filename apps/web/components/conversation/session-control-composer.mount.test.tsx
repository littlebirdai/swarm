import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import "../chat/ChatMessage";
import { armJointSend, setJointCandidates } from "../../lib/joint-send";
import { MessageInput } from "../message-input";
import { NonOwnerMessageInput } from "./session-controls";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import type { ConversationData } from "./types";
import type {
  ComposerBaton,
  ComposerCommandOutcome,
  ComposerControlCommand,
  ComposerControlFacts,
  ComposerControlFlag,
} from "./composer-control-model";

const ana = { id: "ana", name: "Ana" };
const me = { id: "me", name: "Casey" };
let session = 0;

function fakeBaton() {
  const commands: ComposerControlCommand[] = [];
  const replies: Array<{
    resolve: (value: ComposerCommandOutcome) => void;
    reject: (error: Error) => void;
  }> = [];
  const baton: ComposerBaton = {
    run(command) {
      commands.push(command);
      return new Promise((resolve, reject) =>
        replies.push({ resolve, reject }),
      );
    },
  };
  return {
    commands,
    control(
      conversationId: string,
      overrides: Partial<ComposerControlFacts> = {},
    ): ComposerControlFlag {
      return {
        enabled: true,
        conversationId,
        shared: {
          baton,
          facts: {
            viewerId: me.id,
            role: "owner",
            driver: me,
            turn: "t1",
            takeoverPending: false,
            driveRequested: false,
            sendState: null,
            ...overrides,
          },
        },
      };
    },
    async reply(result: ComposerCommandOutcome | Error) {
      const reply = replies.shift();
      if (!reply) throw new Error("No command to settle");
      await act(async () => {
        if (result instanceof Error) reply.reject(result);
        else reply.resolve(result);
      });
    },
  };
}

function id() {
  return `control-test-${++session}`;
}

function owner(
  conversationId: string,
  composerControl?: ComposerControlFlag,
  extra: Partial<React.ComponentProps<typeof MessageInput>> = {},
) {
  return (
    <MessageInput
      key={conversationId}
      conversationId={conversationId}
      composerControl={composerControl}
      status="active"
      agentType="claude_code"
      {...extra}
    />
  );
}

function collaborator(
  conversationId: string,
  composerControl: ComposerControlFlag,
) {
  return (
    <NonOwnerMessageInput
      conversation={{
        _id: conversationId as ConversationData["_id"],
        title: "Shared",
        messages: [],
      }}
      composerControl={composerControl}
    />
  );
}

async function mountComposer(node: ReactNode) {
  const ui = await mountWeb(node, {
    authenticated: true,
    dispatch: true,
    setup(backend) {
      backend.set(api.pendingMessages.getConversationPendingMessage, pending);
      backend.set(api.docSync.getPresence, []);
      backend.mutation(api.docSync.updatePresence, null);
      backend.mutation(api.docSync.removePresence, null);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  const box = () => {
    const input = ui.container.querySelector<HTMLTextAreaElement>(
      "textarea[data-chat-input]",
    );
    if (!input) throw new Error("Composer textarea missing");
    return input;
  };
  return {
    ...ui,
    box,
    async type(text: string) {
      await act(async () => {
        const input = box();
        const setValue = Object.getOwnPropertyDescriptor(
          ui.dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setValue.call(input, text);
        input.dispatchEvent(
          new ui.dom.window.Event("input", { bubbles: true }),
        );
      });
    },
    async press(key: string, options: KeyboardEventInit = {}, times = 1) {
      await act(async () => {
        for (let i = 0; i < times; i += 1)
          box().dispatchEvent(
            new ui.dom.window.KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
              ...options,
            }),
          );
      });
    },
  };
}

function button(root: ParentNode, name: string) {
  const match = [...root.querySelectorAll("button")].find(
    (control) =>
      (control.getAttribute("aria-label") ?? control.textContent?.trim()) ===
      name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

test("flag off, solo and a foreign control preserve the real composer and its backend traffic", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conversationId));
  await ui.type("Keep this draft");
  const input = ui.box();
  const html = ui.container.innerHTML;
  const writes = ui.backend.writeRequests.length;
  const queries = ui.backend.queryRequests.length;
  for (const flag of [
    { enabled: false } as const,
    { enabled: true, conversationId, shared: null } as const,
    fake.control(id()),
  ]) {
    await ui.rerender(owner(conversationId, flag));
    expect(ui.box()).toBe(input);
    expect(ui.container.innerHTML).toBe(html);
    expect(ui.backend.queryRequests).toHaveLength(queries);
    expect(ui.backend.writeRequests).toHaveLength(writes);
  }
  expect(fake.commands).toEqual([]);
});

test("solo to shared to solo keeps the editor, its text and focus", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conversationId));
  const input = ui.box();
  await act(() => input.focus());
  await ui.type("Draft on both sides");
  await ui.rerender(owner(conversationId, fake.control(conversationId)));
  expect(ui.container.textContent).toContain("Driving · You");
  expect(ui.box()).toBe(input);
  await ui.rerender(
    owner(conversationId, { enabled: true, conversationId, shared: null }),
  );
  expect(
    ui.container.querySelector('[aria-label="Session control"]'),
  ).toBeNull();
  expect(ui.box()).toBe(input);
  expect(input.value).toBe("Draft on both sides");
  expect(ui.dom.window.document.activeElement).toBe(input);
});

test("the owner editor clears immediately and submits one steer with the observed turn", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId)),
  );
  await ui.type("Steer now");
  await ui.press("Enter", {}, 2);
  expect(ui.box().value).toBe("");
  expect(fake.commands).toEqual([
    {
      kind: "send",
      text: "Steer now",
      typedWords: "Steer now",
      expected: { kind: "turn", turn: "t1" },
    },
  ]);
  expect(button(ui.container, "Send").disabled).toBe(true);
  await fake.reply("accepted");
});

test.each([
  ["stale", "Turn ended"],
  ["refused", "Send refused"],
] as const)(
  "%s steer restores an empty editor and offers Queue",
  async (result, label) => {
    const conversationId = id();
    const fake = fakeBaton();
    const ui = await mountComposer(
      owner(conversationId, fake.control(conversationId)),
    );
    await ui.type("Please keep this");
    await ui.press("Enter");
    expect(ui.box().value).toBe("");
    await fake.reply(result);
    expect(ui.box().value).toBe("Please keep this");
    expect(ui.container.textContent).toContain(label);
    await act(() => button(ui.container, "Queue").click());
    expect(fake.commands.at(-1)).toMatchObject({
      kind: "queue",
      text: "Please keep this",
    });
    await fake.reply("accepted");
  },
);

test("a retained send gets its own Queue row when the person typed another draft", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId)),
  );
  await ui.type("First draft");
  await ui.press("Enter");
  await ui.type("Second draft");
  await fake.reply("retained");
  expect(ui.box().value).toBe("Second draft");
  const retry = ui.container.querySelector('[aria-label="Draft to retry"]')!;
  expect(retry.textContent).toContain("First draft");
  await act(() => {
    button(retry, "Queue").click();
    button(retry, "Queue").click();
  });
  expect(fake.commands).toHaveLength(2);
  expect(fake.commands.at(-1)).toMatchObject({
    kind: "queue",
    text: "First draft",
  });
  await fake.reply("accepted");
  expect(
    ui.container.querySelector('[aria-label="Draft to retry"]'),
  ).toBeNull();
  expect(ui.box().value).toBe("Second draft");
});

test("a late result stays with its session and a rejected promise shows delivery in doubt", async () => {
  const conversationId = id();
  const nextId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId)),
  );
  await ui.type("First session");
  await ui.press("Enter");
  await ui.rerender(owner(nextId, fake.control(nextId)));
  await ui.type("Second session");
  await fake.reply(new Error("Disconnected"));
  await ui.rerender(owner(nextId, fake.control(nextId)));
  expect(ui.box().value).toBe("Second session");
  expect(ui.container.textContent).not.toContain("Delivery in doubt");
  await ui.rerender(owner(conversationId, fake.control(conversationId)));
  expect(ui.container.textContent).toContain("Delivery in doubt");
  expect(
    ui.container.querySelector('[aria-label="Draft to retry"]')?.textContent,
  ).toContain("First session");
});

test("takeover confirms the observed driver once and cancel is idempotent", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId, { driver: ana })),
  );
  const takeover = button(ui.container, "Take over");
  await act(() => takeover.click());
  expect(takeover.getAttribute("aria-expanded")).toBe("true");
  expect(fake.commands).toEqual([]);
  const confirm = ui.dom.window.document.querySelector<HTMLButtonElement>(
    "[data-switch-confirm]",
  )!;
  await act(() => {
    confirm.click();
    confirm.click();
  });
  expect(fake.commands).toEqual([
    {
      kind: "takeover",
      driverId: "ana",
      expected: { kind: "turn", turn: "t1" },
    },
  ]);
  await fake.reply("accepted");
  await ui.rerender(
    owner(
      conversationId,
      fake.control(conversationId, { driver: ana, takeoverPending: true }),
    ),
  );
  expect(ui.container.textContent).toContain("Taking over");
  const cancel = button(ui.container, "Cancel takeover");
  await act(() => {
    cancel.click();
    cancel.click();
  });
  await fake.reply("accepted");
  expect(fake.commands.at(-1)).toEqual({ kind: "cancel-takeover" });
  expect(fake.commands).toHaveLength(2);
  expect(cancel.disabled).toBe(true);
});

test("takeover confirmation expires on a turn change and shows no confirm key", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId, { driver: ana })),
  );
  await act(() => button(ui.container, "Take over").click());
  await ui.rerender(
    owner(
      conversationId,
      fake.control(conversationId, { driver: ana, turn: "t2" }),
    ),
  );
  const confirm = ui.dom.window.document.querySelector<HTMLButtonElement>(
    "[data-switch-confirm]",
  )!;
  expect(confirm.disabled).toBe(true);
  expect(confirm.textContent).toBe("Driver or turn changed");
  expect(fake.commands).toEqual([]);
});

test("the existing Escape path interrupts the observed turn only once", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  let legacyStops = 0;
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId), {
      onSendEscape: () => {
        legacyStops += 1;
      },
    }),
  );
  await ui.press("Escape", {}, 2);
  expect(fake.commands).toEqual([
    { kind: "interrupt", expected: { kind: "turn", turn: "t1" } },
  ]);
  expect(legacyStops).toBe(0);
  await fake.reply("accepted");
});

test("the collaborator composer queues, suggests and gives a viewer only Ask to drive", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    collaborator(
      conversationId,
      fake.control(conversationId, { role: "sender", driver: ana }),
    ),
  );
  const input = ui.box();
  await ui.type("After Ana");
  await act(() => button(ui.container, "Queue").click());
  expect(input.value).toBe("");
  expect(fake.commands.at(-1)).toEqual({ kind: "queue", text: "After Ana" });
  await fake.reply("accepted");
  await ui.rerender(
    collaborator(
      conversationId,
      fake.control(conversationId, { role: "suggester", driver: ana }),
    ),
  );
  expect(ui.box()).toBe(input);
  await ui.type("My suggestion");
  await act(() => button(ui.container, "Suggest").click());
  expect(fake.commands.at(-1)).toEqual({
    kind: "suggest",
    text: "My suggestion",
  });
  await fake.reply("accepted");
  await ui.rerender(
    collaborator(
      conversationId,
      fake.control(conversationId, { role: "viewer", driver: ana }),
    ),
  );
  expect(input.closest("[hidden]")).not.toBeNull();
  const ask = button(ui.container, "Ask to drive");
  await act(() => {
    ask.click();
    ask.click();
  });
  expect(fake.commands).toHaveLength(3);
  expect(fake.commands.at(-1)).toEqual({ kind: "ask" });
  await fake.reply("accepted");
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
});

test("the shared owner path holds a credential before any baton command", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId)),
  );
  const text = `sk_test_${"a1B2c3D4e5".repeat(3)}`;
  await ui.type(text);
  await ui.press("Enter");
  expect(ui.box().value).toBe(text);
  expect(ui.container.textContent).toContain("Save to Vault and send");
  expect(fake.commands).toEqual([]);
});

test("a workflow gate keeps its existing submit path when passed a shared control", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const gate: string[] = [];
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId), {
      onGateSend: (text) => {
        gate.push(text);
      },
    }),
  );
  await ui.type("Continue the gate");
  await ui.press("Enter");
  expect(gate).toEqual(["Continue the gate"]);
  expect(fake.commands).toEqual([]);
  expect(
    ui.container.querySelector('[aria-label="Session control"]'),
  ).toBeNull();
});

test("Ask to drive can retry after a rejection or a settled request", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    collaborator(
      conversationId,
      fake.control(conversationId, { role: "viewer", driver: ana }),
    ),
  );
  await act(() => button(ui.container, "Ask to drive").click());
  await fake.reply(new Error("Disconnected"));
  expect(ui.container.textContent).toContain("Control request in doubt");
  await act(() => button(ui.container, "Ask to drive").click());
  expect(fake.commands).toEqual([{ kind: "ask" }, { kind: "ask" }]);
  await fake.reply("accepted");
  await ui.rerender(
    collaborator(
      conversationId,
      fake.control(conversationId, {
        role: "viewer",
        driver: ana,
        driveRequested: true,
      }),
    ),
  );
  await ui.rerender(
    collaborator(
      conversationId,
      fake.control(conversationId, { role: "viewer", driver: ana }),
    ),
  );
  await act(() => button(ui.container, "Ask to drive").click());
  expect(fake.commands).toHaveLength(3);
  await fake.reply("accepted");
});

test("a joint draft is claimed only after the baton accepts the send", async () => {
  const conversationId = id();
  const fake = fakeBaton();
  const claimed: string[] = [];
  const candidates = [{ user_id: ana.id, from: ana.name, text: "Ana's draft" }];
  const ui = await mountComposer(
    owner(conversationId, fake.control(conversationId)),
  );
  try {
    setJointCandidates(conversationId, me.name, candidates, (rows) =>
      claimed.push(...rows.map((row) => row.text)),
    );
    await ui.type("Our draft");
    armJointSend(conversationId);
    await ui.press("Enter");
    expect(fake.commands[0]).toMatchObject({ kind: "send" });
    expect("text" in fake.commands[0] && fake.commands[0].text).toContain(
      "Ana's draft",
    );
    expect(claimed).toEqual([]);
    await fake.reply("accepted");
    expect(claimed).toEqual(["Ana's draft"]);
  } finally {
    setJointCandidates(conversationId, me.name, [], () => {});
  }
});

test("a collaborator draft survives both flag changes and a session switch", async () => {
  const conversationId = id();
  const nextId = id();
  const fake = fakeBaton();
  const shared = fake.control(conversationId, { role: "sender", driver: ana });
  const ui = await mountComposer(collaborator(conversationId, shared));
  const input = ui.box();
  await ui.type("Draft from the collaborator");
  await ui.rerender(
    collaborator(conversationId, {
      enabled: true,
      conversationId,
      shared: null,
    }),
  );
  expect(ui.box()).toBe(input);
  expect(input.value).toBe("Draft from the collaborator");
  await ui.rerender(collaborator(nextId, fake.control(nextId)));
  expect(ui.box().value).toBe("");
  await ui.rerender(collaborator(conversationId, shared));
  expect(ui.box().value).toBe("Draft from the collaborator");
});
