import { expect, test } from "bun:test";
import { mountWeb } from "../../test-helpers/mountWeb";
import { act, cloneElement, createRef } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  ana,
  me,
  fakeBaton,
  id,
  owner,
  collaborator,
  createComposerMount,
  button,
} from "../../test-helpers/composer-control-fixture";

const mountComposer = createComposerMount(mountWeb);

test("a stale steer stops directing Send when the turn changes", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)));
  await ui.type("Draft");
  await ui.press("Enter");
  await fake.reply("stale");
  expect(button(ui.container, "Queue").disabled).toBe(false);
  await ui.rerender(owner(conv, fake.control(conv, { turn: "t2" })));
  expect(button(ui.container, "Send").disabled).toBe(false);
  expect(ui.container.textContent).not.toContain("Turn ended");
});

test("a newer server receipt replaces an in-doubt result and an ask error disappears on grant", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)));
  await ui.type("Draft");
  await ui.press("Enter");
  await fake.reply(new Error("Disconnected"));
  expect(ui.container.textContent).toContain("Delivery in doubt");
  for (const kind of ["saved", "with-agent"] as const) {
    await ui.rerender(owner(conv, fake.control(conv, { sendState: { kind } })));
    expect(ui.container.textContent).toContain(
      kind === "saved" ? "Saved" : "With the agent",
    );
    expect(ui.container.textContent).not.toContain("Delivery in doubt");
  }
  await ui.type("Second draft");
  await ui.press("Enter");
  await ui.rerender(
    owner(conv, fake.control(conv, { sendState: { kind: "saved" } })),
  );
  expect(ui.container.textContent).toContain("Saved");
  expect(ui.container.textContent).not.toContain("Saving");
  await fake.reply("accepted");
  await ui.rerender(owner(conv, fake.control(conv, { role: "viewer" })));
  await act(() => button(ui.container, "Ask to drive").click());
  await fake.reply("refused");
  expect(ui.container.textContent).toContain("Control request refused");
  await ui.rerender(owner(conv, fake.control(conv, { role: "sender" })));
  expect(ui.container.textContent).not.toContain("Control request refused");
});

test("direct takeover and direct grant can recur after their facts change back", async () => {
  const conv = id();
  const fake = fakeBaton();
  const show = (driver: typeof ana) =>
    owner(conv, fake.control(conv, { driver, turn: null }));
  const ui = await mountComposer(show(ana));
  await act(() => button(ui.container, "Take over").click());
  const confirm = ui.dom.window.document.querySelector<HTMLButtonElement>(
    "[data-switch-confirm]",
  )!;
  await act(() => confirm.click());
  await fake.reply("accepted");
  expect(button(ui.container, "Take over").disabled).toBe(true);
  await ui.rerender(show(me));
  await ui.rerender(show(ana));
  expect(button(ui.container, "Take over").disabled).toBe(false);
  await ui.rerender(owner(conv, fake.control(conv, { role: "viewer" })));
  await act(() => button(ui.container, "Ask to drive").click());
  await fake.reply("accepted");
  expect(button(ui.container, "Drive requested").disabled).toBe(true);
  await ui.rerender(owner(conv, fake.control(conv, { role: "sender" })));
  await ui.rerender(owner(conv, fake.control(conv, { role: "viewer" })));
  expect(button(ui.container, "Ask to drive").disabled).toBe(false);
});

test("draft activation saves live text or loads stored text and solo stops writing", async () => {
  const conv = id();
  const next = id();
  const fake = fakeBaton();
  const solo = { enabled: false } as const;
  const ui = await mountComposer(collaborator(conv, solo), { clock: true });
  await ui.type("From solo");
  await ui.rerender(collaborator(conv, fake.control(conv)));
  await ui.rerender(collaborator(next, solo));
  expect(ui.store.getState().getDraft(conv)?.draft_message).toBe("From solo");
  await ui.rerender(collaborator(conv, solo));
  expect(ui.box().value).toBe("");
  await ui.rerender(collaborator(conv, fake.control(conv)));
  expect(ui.box().value).toBe("From solo");
  await ui.type("Final shared draft");
  await ui.rerender(collaborator(conv, solo));
  expect(ui.store.getState().getDraft(conv)?.draft_message).toBe(
    "Final shared draft",
  );
  await ui.type("Only in solo");
  await ui.clock!.advance(350);
  expect(ui.store.getState().getDraft(conv)?.draft_message).toBe(
    "Final shared draft",
  );
});

test("viewer removes owner edit controls and cannot populate the collaborator draft", async () => {
  const conv = id();
  const fake = fakeBaton();
  const populate = createRef<((text: string) => void) | null>();
  const drop = createRef<((files: File[]) => void) | null>();
  const control = fake.control(conv, { role: "viewer" });
  const ui = await mountComposer(
    owner(conv, control, {
      acceptFiles: true,
      onDropFiles: drop,
      permissionMode: "default",
      composerFoot: <button>Attach test file</button>,
      onPopulateInput: populate,
    }),
  );
  expect(
    ui.container.querySelector(
      "textarea, [contenteditable], [data-cc-send], [data-composer-mode]",
    ),
  ).toBeNull();
  expect(ui.container.textContent).not.toContain("Attach test file");
  expect(populate.current).toBeNull();
  expect(drop.current).toBeNull();
  expect(button(ui.container, "Ask to drive").disabled).toBe(false);
  await ui.rerender(collaborator(conv, control, populate));
  expect(populate.current).toBeNull();
  expect(ui.box().closest("[hidden]")).not.toBeNull();
});

test("Shift Escape checks the credential and the active submission before interrupting", async () => {
  const conv = "jx70000000000000000000000strpesc";
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)));
  await ui.type(`sk_test_${"a1B2c3D4e5".repeat(3)}`);
  await ui.press("Escape", { shiftKey: true });
  expect(ui.container.textContent).toContain("Save to Vault and send");
  expect(fake.commands).toEqual([]);
  await ui.press("Escape");
  await ui.type("First");
  await ui.press("Enter");
  await ui.type("Second");
  await ui.press("Escape", { shiftKey: true });
  expect(fake.commands.map((command) => command.kind)).toEqual(["send"]);
  await fake.reply("accepted");
  await ui.press("Escape", { shiftKey: true });
  expect(fake.commands.map((command) => command.kind)).toEqual([
    "send",
    "interrupt",
    "queue",
  ]);
  await fake.reply("accepted");
  await fake.reply("accepted");
});

test.each([
  ["advance", { altKey: true }],
  ["dismiss", { altKey: true, shiftKey: true }],
] as const)(
  "Alt Enter respects the accepted result before %s",
  async (_action, keys) => {
    const conv = id();
    const fake = fakeBaton();
    let navigations = 0;
    const navigate = () => {
      navigations += 1;
    };
    const ui = await mountComposer(
      owner(conv, fake.control(conv), {
        onSendAndAdvance: navigate,
        onSendAndDismiss: navigate,
      }),
    );
    await ui.type("Draft");
    for (const result of [
      "stale",
      "refused",
      "retained",
      "accepted",
    ] as const) {
      await ui.press("Enter", keys);
      expect(navigations).toBe(0);
      await fake.reply(result);
    }
    expect(navigations).toBe(1);
  },
);

test("retaining an image-only send restores the attachment without draft text", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)), {
    setup(_backend, store) {
      store.setDraft(conv, {
        draft_image_storage_ids: [
          { storageId: "image-1", previewUrl: "data:image/png;base64,AA" },
        ],
      });
    },
  });
  await ui.press("Enter");
  expect(fake.commands.at(0)).toMatchObject({
    text: "[image]",
    imageIds: ["image-1"],
  });
  await fake.reply("retained");
  expect(ui.box().value).toBe("");
  expect(
    ui.store.getState().getDraft(conv)?.draft_image_storage_ids,
  ).toMatchObject([{ storageId: "image-1" }]);
  expect(ui.store.getState().getDraft(conv)?.draft_message).toBeNull();
});

test("Suggest has its own icon and busy appearance and never offers Send together", async () => {
  const conv = id();
  const fake = fakeBaton();
  const show = (role: "sender" | "suggester") =>
    collaborator(conv, fake.control(conv, { role, driver: ana }));
  const ui = await mountComposer(show("sender"));
  await act(() =>
    ui.backend.set(api.docSync.getPresence, [
      {
        user_id: ana.id as Id<"users">,
        user_name: ana.name,
        user_color: "#123456",
        user_image: undefined,
        cursor_pos: undefined,
        anchor_pos: undefined,
        anchor: undefined,
        anchor_at: undefined,
        claims: undefined,
        in_draft: undefined,
        draft_text: "Draft from Ana",
        can_send: true,
        updated_at: Date.now(),
      },
    ]),
  );
  const together = () => ui.container.querySelector("[data-sv-send-together]");
  expect(together()).not.toBeNull();
  await ui.rerender(show("suggester"));
  expect(together()).toBeNull();
  await ui.type("Suggestion");
  const suggest = button(ui.container, "Suggest");
  expect(suggest.querySelector("svg")?.getAttribute("class")).toContain(
    "lucide-lightbulb",
  );
  await act(() => suggest.click());
  await ui.type("Next draft");
  expect(suggest.disabled).toBe(true);
  expect(suggest.querySelector("svg")?.getAttribute("class")).toContain(
    "animate-spin",
  );
  expect(suggest.className).toContain("cursor-not-allowed");
  await fake.reply("accepted");
});

test("retry rows can offer Suggest and dismiss an in-doubt delivery", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(
    collaborator(conv, fake.control(conv, { role: "suggester" })),
  );
  await ui.type("First suggestion");
  await ui.press("Enter");
  await fake.reply(new Error("Disconnected"));
  const retry = () =>
    ui.container.querySelector('[aria-label="Draft to retry"]')!;
  await act(() => button(retry(), "Suggest").click());
  expect(fake.commands.at(-1)).toEqual({
    kind: "suggest",
    text: "First suggestion",
  });
  await fake.reply(new Error("Still disconnected"));
  await act(() => button(retry(), "Dismiss").click());
  expect(retry()).toBeNull();
  expect(fake.commands).toHaveLength(2);
});

test.each([
  ["a non-holder", { role: "sender", driver: ana, turn: "t1" }],
  ["an owner with no turn", { role: "owner", driver: me, turn: null }],
] as const)("%s sees no Interrupt action", async (_label, facts) => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv, facts)), {
    clock: true,
  });
  expect(ui.container.textContent).not.toContain("Interrupt");
  await ui.press("Escape");
  await ui.clock!.advance(500);
  expect(fake.commands).toEqual([]);
});

test("a disabled Interrupt tooltip has no keyboard hint", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)), {
    clock: true,
  });
  await ui.press("Escape");
  expect(button(ui.container, "Interrupt").disabled).toBe(true);
  for (let i = 0; i < 2; i++) {
    const trigger = button(ui.container, "Interrupt").parentElement!;
    await act(() => {
      trigger.tabIndex = -1;
      trigger.focus();
    });
  }
  await ui.clock!.advance(350);
  expect(
    ui.dom.window.document.querySelector('[role="tooltip"]')?.textContent,
  ).toBe("Interrupt");
  await fake.reply("accepted");
});

test("a late retained result cannot restore into the same editor after it changes conversation", async () => {
  const conv = id();
  const next = id();
  const fake = fakeBaton();
  const show = (key: string) =>
    cloneElement(owner(key, fake.control(key)), { key: "same-instance" });
  const ui = await mountComposer(show(conv));
  const editor = ui.box();
  await ui.type("Old draft");
  await ui.press("Enter");
  await ui.rerender(show(next));
  expect(ui.box()).toBe(editor);
  await fake.reply("stale");
  expect(editor.value).toBe("");
  await ui.rerender(show(conv));
  expect(
    ui.container.querySelector('[aria-label="Draft to retry"]')?.textContent,
  ).toContain("Old draft");
});

test("a second Escape after acceptance does not interrupt the same turn again", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)), {
    clock: true,
  });
  await ui.press("Escape");
  await fake.reply("accepted");
  await ui.rerender(
    owner(conv, fake.control(conv, { sendState: { kind: "saved" } })),
  );
  await ui.clock!.advance(450);
  await ui.press("Escape");
  expect(fake.commands).toEqual([
    { kind: "interrupt", expected: { kind: "turn", turn: "t1" } },
  ]);
});

test("returning from solo clears the previous shared outcome for the same facts", async () => {
  const conv = id();
  const fake = fakeBaton();
  const shared = fake.control(conv, { driver: ana });
  const solo = { enabled: true, conversationId: conv, shared: null } as const;
  const ui = await mountComposer(owner(conv, shared));

  await act(() => button(ui.container, "Take over").click());
  await act(() =>
    ui.dom.window.document
      .querySelector<HTMLButtonElement>("[data-switch-confirm]")!
      .click(),
  );
  await fake.reply("accepted");
  expect(button(ui.container, "Take over").disabled).toBe(true);
  await ui.type("Retained draft");
  await ui.press("Enter");
  await fake.reply("stale");
  expect(ui.container.textContent).toContain("Turn ended");
  await act(() => button(ui.container, "Interrupt").click());
  await fake.reply("refused");
  expect(ui.container.textContent).toContain("Control request refused");

  await ui.rerender(owner(conv, solo));
  await ui.rerender(owner(conv, shared));
  expect(button(ui.container, "Take over").disabled).toBe(false);
  expect(ui.container.textContent).not.toContain("Turn ended");
  expect(ui.container.textContent).not.toContain("Control request refused");
  expect(ui.box().value).toBe("Retained draft");
});

test("an old interrupt cannot block or release the interrupt for a newer turn", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)), {
    clock: true,
  });
  await ui.press("Escape");
  expect(button(ui.container, "Interrupt").disabled).toBe(true);
  await ui.rerender(owner(conv, fake.control(conv, { turn: "t2" })));
  expect(button(ui.container, "Interrupt").disabled).toBe(false);
  await ui.clock!.advance(450);
  await ui.press("Escape");
  expect(fake.commands).toEqual([
    { kind: "interrupt", expected: { kind: "turn", turn: "t1" } },
    { kind: "interrupt", expected: { kind: "turn", turn: "t2" } },
  ]);
  await fake.reply("accepted");
  expect(button(ui.container, "Interrupt").disabled).toBe(true);
  await ui.clock!.advance(450);
  await ui.press("Escape");
  expect(fake.commands).toHaveLength(2);
  await fake.reply("refused");
  expect(button(ui.container, "Interrupt").disabled).toBe(false);
});

test("a newer server receipt leaves Send disabled until the pending command settles", async () => {
  const conv = id();
  const fake = fakeBaton();
  const ui = await mountComposer(owner(conv, fake.control(conv)));
  await ui.type("First draft");
  await ui.press("Enter");
  await ui.type("Second draft");
  for (const turn of ["t1", "t2"]) {
    await ui.rerender(
      owner(conv, fake.control(conv, { turn, sendState: { kind: "saved" } })),
    );
    expect(ui.container.textContent).toContain("Saved");
    expect(ui.container.textContent).not.toContain("Saving");
    expect(button(ui.container, "Send").disabled).toBe(true);
    await ui.press("Enter");
    expect(fake.commands).toHaveLength(1);
  }
  await fake.reply("accepted");
  expect(button(ui.container, "Send").disabled).toBe(false);
  expect(ui.box().value).toBe("Second draft");
});
