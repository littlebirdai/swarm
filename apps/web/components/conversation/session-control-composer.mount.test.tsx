import { expect, test } from "bun:test";
import { act, useSyncExternalStore } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { ComposerSendButton } from "../ComposerShell";
import { SessionControlComposer } from "./session-control-composer";
import {
  selectComposerControl,
  type ComposerBaton,
  type ComposerControlCommand,
  type ComposerControlFacts,
  type ComposerControlFlag,
  type SendState,
} from "./composer-control-model";

const conversationId = "session-1";
const ana = { id: "ana", name: "Ana" };
const me = { id: "me", name: "Casey" };

function ComposerSlot({ control }: { control?: ComposerControlFlag }) {
  const active = selectComposerControl(control, conversationId);
  return active ? (
    <SessionControlComposer {...active} />
  ) : (
    <ComposerSendButton canSubmit />
  );
}

function fakeBaton(initial: Partial<ComposerControlFacts> = {}) {
  let facts: ComposerControlFacts = {
    viewerId: me.id,
    role: "sender",
    driver: me,
    turn: "t1",
    takeoverPending: false,
    driveRequested: false,
    sendState: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const commands: ComposerControlCommand[] = [];
  let finish: ((status: SendState) => void) | undefined;
  function update(change: Partial<ComposerControlFacts>) {
    facts = { ...facts, ...change };
    for (const listener of listeners) listener();
  }
  const baton: ComposerBaton = {
    async run(command) {
      commands.push(command);
      switch (command.kind) {
        case "ask":
          update({ driveRequested: true });
          return "accepted";
        case "takeover":
          update({ takeoverPending: true });
          return "accepted";
        case "cancel-takeover":
          update({ takeoverPending: false });
          return "accepted";
        case "send":
        case "queue": {
          update({ sendState: { kind: "submitting" } });
          const sendState = await new Promise<SendState>((resolve) => {
            finish = resolve;
          });
          update({ sendState });
          return sendState.kind === "stale" || sendState.kind === "refused"
            ? "retained"
            : "accepted";
        }
      }
    },
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function Composer() {
    const snapshot = useSyncExternalStore(subscribe, () => facts);
    return (
      <ComposerSlot
        control={{
          enabled: true,
          conversationId,
          shared: { facts: snapshot, baton },
        }}
      />
    );
  }

  return {
    Composer,
    baton,
    commands,
    update: async (change: Partial<ComposerControlFacts>) =>
      act(() => update(change)),
    settle: async (status: SendState) => {
      const settle = finish;
      if (!settle) throw new Error("No send to settle");
      finish = undefined;
      await act(async () => settle(status));
    },
  };
}

async function mountComposer(fake: ReturnType<typeof fakeBaton>) {
  const mounted = await mountWeb(<fake.Composer />);
  const { container, dom } = mounted;
  const box = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]',
  )!;
  return {
    ...mounted,
    box,
    type: async (text: string) =>
      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setValue.call(box, text);
        box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }),
    enter: async (options: KeyboardEventInit = {}) =>
      act(() => {
        box.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
      }),
  };
}

function button(root: ParentNode, name: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find(
    (control) =>
      (control.getAttribute("aria-label") ?? control.textContent?.trim()) ===
      name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

test("flag off and a solo session leave the normal Send surface intact", async () => {
  const mounted = await mountWeb(<ComposerSlot />);
  const verifyFallback = () => {
    expect(mounted.container.querySelectorAll("button")).toHaveLength(1);
    expect(button(mounted.container, "Send").disabled).toBe(false);
    expect(
      mounted.container.querySelector('div[aria-label="Session control"]'),
    ).toBeNull();
  };
  verifyFallback();
  await mounted.rerender(<ComposerSlot control={{ enabled: false }} />);
  verifyFallback();
  await mounted.rerender(
    <ComposerSlot control={{ enabled: true, conversationId, shared: null }} />,
  );
  verifyFallback();
  expect(mounted.backend.queryRequests).toEqual([]);
  expect(mounted.backend.mutations).toEqual([]);
  expect(mounted.backend.actions).toEqual([]);
});

test("driver presses Enter to steer the exact observed turn", async () => {
  const fake = fakeBaton();
  const ui = await mountComposer(fake);
  expect(ui.container.textContent).toContain("Driving · You");
  await ui.type("Steer now");
  await ui.enter();
  expect(fake.commands).toEqual([
    { kind: "send", text: "Steer now", expected: { kind: "turn", turn: "t1" } },
  ]);
  expect(button(ui.container, "Send").disabled).toBe(true);
  await fake.settle({ kind: "with-agent" });
  expect(ui.box.value).toBe("");
  expect(ui.container.textContent).toContain("With the agent");
});

test("Enter during input method composition leaves the draft in place", async () => {
  const fake = fakeBaton();
  const ui = await mountComposer(fake);
  await ui.type("変換");
  await ui.enter({ isComposing: true });
  await ui.enter({ keyCode: 229 });
  expect(fake.commands).toEqual([]);
  expect(ui.box.value).toBe("変換");
});

test("a sender queues behind the named driver", async () => {
  const fake = fakeBaton({ driver: ana });
  const ui = await mountComposer(fake);
  expect(ui.container.textContent).toContain("Driving · Ana");
  await ui.type("After Ana");
  await act(() => button(ui.container, "Queue").click());
  expect(fake.commands).toEqual([{ kind: "queue", text: "After Ana" }]);
  await fake.settle({ kind: "waiting-for-driver", driver: "Ana" });
  expect(ui.box.value).toBe("");
  expect(ui.container.textContent).toContain("Waiting for Ana");
});

test("a viewer asks to drive without submitting the draft", async () => {
  const fake = fakeBaton({ role: "viewer", driver: ana });
  const ui = await mountComposer(fake);
  await ui.type("For later");
  await ui.enter();
  expect(fake.commands).toEqual([]);
  await act(() => button(ui.container, "Ask to drive").click());
  expect(fake.commands).toEqual([{ kind: "ask" }]);
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
  expect(ui.box.value).toBe("For later");
});

test("takeover uses a confirm, queues while waiting, and can be canceled", async () => {
  const fake = fakeBaton({ role: "owner", driver: ana });
  const ui = await mountComposer(fake);
  const doc = ui.dom.window.document;
  await act(() => button(ui.container, "Take over").click());
  expect(doc.querySelector('[role="dialog"]')).not.toBeNull();
  expect(fake.commands).toEqual([]);
  await act(() =>
    doc.querySelector<HTMLButtonElement>("[data-switch-cancel]")!.click(),
  );
  expect(fake.commands).toEqual([]);
  await act(() => button(ui.container, "Take over").click());
  await act(() =>
    doc.querySelector<HTMLButtonElement>("[data-switch-confirm]")!.click(),
  );
  expect(fake.commands).toEqual([
    {
      kind: "takeover",
      driverId: "ana",
      expected: { kind: "turn", turn: "t1" },
    },
  ]);
  expect(ui.container.textContent).toContain(
    "Taking over · Waiting for the machine",
  );
  await ui.type("When I have control");
  await ui.enter();
  expect(fake.commands.at(-1)).toEqual({
    kind: "queue",
    text: "When I have control",
  });
  await fake.settle({ kind: "waiting-for-machine" });
  await act(() => button(ui.container, "Cancel takeover").click());
  expect(fake.commands.at(-1)).toEqual({ kind: "cancel-takeover" });
  expect(ui.container.textContent).not.toContain("Taking over");
});

test("a takeover confirmation expires when the turn changes", async () => {
  const fake = fakeBaton({ role: "owner", driver: ana });
  const ui = await mountComposer(fake);
  await act(() => button(ui.container, "Take over").click());
  await fake.update({ turn: "t2" });
  expect(
    ui.dom.window.document.querySelector<HTMLButtonElement>(
      "[data-switch-confirm]",
    )!.disabled,
  ).toBe(true);
  expect(fake.commands).toEqual([]);
});

test.each([
  ["stale", "Turn ended"],
  ["refused", "Send refused"],
] as const)(
  "%s steer retains the draft and offers Queue",
  async (kind, label) => {
    const fake = fakeBaton();
    const ui = await mountComposer(fake);
    await ui.type("Please keep this");
    await ui.enter();
    await fake.settle({ kind });
    expect(ui.box.value).toBe("Please keep this");
    expect(ui.container.textContent).toContain(label);
    await act(() => button(ui.container, "Queue").click());
    expect(fake.commands.at(-1)).toEqual({
      kind: "queue",
      text: "Please keep this",
    });
    await fake.settle({ kind: "saved" });
    expect(ui.box.value).toBe("");
  },
);

test("a send receipt leaves text typed after submission in the composer", async () => {
  const fake = fakeBaton();
  const ui = await mountComposer(fake);
  await ui.type("First");
  await ui.enter({ ctrlKey: true });
  expect(fake.commands).toEqual([{ kind: "queue", text: "First" }]);
  await ui.type("Second");
  await fake.settle({ kind: "saved" });
  expect(ui.box.value).toBe("Second");
});
