import { api } from "@codecast/convex/convex/_generated/api";
import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { SessionDecisionItem } from "../../../store/inboxStore";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { DecisionCompactCard } from "../DecisionCompactCard";

const T = 1_800_000_000_000;
const decision: SessionDecisionItem = {
  _id: "d1",
  short_id: "sd-9",
  conversation_id: "c1",
  session_id: "s1",
  question: "Ship the cart fix?",
  options: [{ label: "Ship" }, { label: "Revise" }],
  blocking: true,
  status: "pending",
  kind: "single",
  created_at: T,
};
const comments = {
  k1: {
    _id: "k1",
    decision_id: "d1",
    client_id: "x1",
    content: "You own the parser now.",
    created_at: T + 1,
    author_kind: "user",
    author_user_id: "u1",
    author_name: "Ashot",
    decision_event: "passed",
    event_to_names: ["Samvit"],
  },
  k2: {
    _id: "k2",
    decision_id: "d1",
    client_id: "x2",
    content: "Does this touch checkout?",
    created_at: T + 2,
    author_kind: "user",
    author_user_id: "u2",
    author_name: "Samvit",
  },
  k3: {
    _id: "k3",
    decision_id: "d1",
    client_id: "x3",
    content: "No: only the cart total.",
    created_at: T + 3,
    author_kind: "agent",
    agent_status: "done",
    author_name: "Fix the cart",
    parent_id: "k2",
    decision_session_id: "c1",
  },
  k4: {
    _id: "k4",
    decision_id: "d1",
    client_id: "x4",
    content: "Thanks.",
    created_at: T - 5,
    author_kind: "user",
    author_user_id: "u1",
    author_name: "Ashot",
  },
};
async function mount(ui: ReactNode, away = false) {
  await import("../../comments/CommentThread");
  const web = await mountWeb(ui, {
    path: "/questions",
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", { _id: "u1", name: "Ashot" });
      store.syncTable("decisionComments", [
        ...Object.values(comments),
        {
          ...comments.k2,
          _id: "unrelated",
          decision_id: "d2",
          content: "Another decision's comment",
        },
      ]);
      store.syncTable("decisionThreads", [
        {
          _id: "d1",
          decision_short_id: "sd-9",
          owner: { conversation_id: "c1", name: "Fix the cart", via: "asker" },
        },
      ]);
      store.syncTable("threadInbox", [
        {
          _id: "decision:decision:d1",
          kind: "decision",
          root_key: "decision:d1",
          decision_id: "d1",
          last_activity_at: T + 3,
          last_read_at: T,
          updated_at: T,
          unread: 2,
        },
      ]);
      if (away) store.setCurrentSession("other");
      backend.set(api.sessionDecisions.get, pending);
      backend.set(api.sessionDecisions.getWithDoc, pending);
      backend.set(api.decisionThread.thread, pending);
      backend.set(api.docSync.getPresence, []);
      backend.mutation(api.docSync.updatePresence, undefined);
      backend.mutation(api.docSync.removePresence, undefined);
      backend.mutation(api.dispatch.dispatch, { ok: true });
    },
  });
  const writes = () =>
    web.backend.mutations.flatMap(({ name, args }) =>
      name === "dispatch:dispatch" &&
      args &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      !(args instanceof ArrayBuffer)
        ? [{ action: args.action, args: args.args }]
        : [],
    );
  const writesFor = (action: string) =>
    writes()
      .filter((row) => row.action === action)
      .map((row) => row.args);
  return { ...web, writes, writesFor, unmount: web.close };
}
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("the card draws the thread: the pass, the comment, the session's answer and where the news starts", async () => {
  const { container, unmount, writesFor } = await mount(
    <DecisionCompactCard decision={decision} />,
  );
  const thread = container.querySelector("[data-decision-thread]")!;
  expectPresent(thread);
  expect(thread.textContent).not.toContain("Another decision's comment");
  const event = thread.querySelector("[data-comment-event]")!;
  expect(event.textContent).toContain("Ashot");
  expect(event.textContent).toContain("passed to Samvit");
  expect(event.textContent).toContain("You own the parser now.");
  expect(thread.textContent).toContain("No: only the cart total.");
  expect(thread.textContent).toContain("Fix the cart");
  // The news starts at the pass (the reader's own pass is not news, so at Samvit's comment), and the card counts it.
  const line = thread.querySelector("[data-comment-new-line]")!;
  expect(line).not.toBeNull();
  expect(thread.querySelectorAll("[data-comment-fresh]").length).toBe(2);
  const unread = container.querySelector("[data-decision-thread-unread-chip]");
  expectPresent(unread);
  expect(unread.textContent).toContain("2 new");
  // Asking the session is a plain button, not an icon.
  expect(thread.querySelector("[data-decision-ask]")!.textContent).toContain(
    "Discuss with",
  );
  // A card leaves it unread until the person opens it.
  expect(writesFor("markThreadRead")).toEqual([]);
  await unmount();
});

test("edit and remove sit only on your own comment, and resolve stamps the thread", async () => {
  const { container, unmount, writesFor } = await mount(
    <DecisionCompactCard decision={decision} />,
  );
  const cards = [...container.querySelectorAll(".cc-cmt-user")];
  const own = cards.find((c) => c.textContent?.includes("Thanks."))!;
  const theirs = cards.find((c) =>
    c.textContent?.includes("Does this touch checkout?"),
  )!;
  expect(own.querySelector('[aria-label="Edit"]')).not.toBeNull();
  expect(own.querySelector('[aria-label="Delete"]')).not.toBeNull();
  expectAbsent(theirs.querySelector('[aria-label="Edit"]'));
  expectAbsent(theirs.querySelector('[aria-label="Delete"]'));
  await click(container.querySelector("[data-comment-resolve=resolve]"));
  expect(writesFor("resolveDecisionThread")).toEqual([["d1", true]]);
  await unmount();
});

test("opening the thread reads it", async () => {
  const { container, unmount, writesFor } = await mount(
    <DecisionCompactCard decision={decision} />,
  );
  await click(container.querySelector("[data-discuss-button]"));
  expect(writesFor("markThreadRead")).toEqual([["decision", "decision:d1"]]);
  await unmount();
});

test("discussing from a card away from the session selects that session, so its reply is followed in the inbox", async () => {
  const { container, navigationLog, unmount, writes, store } = await mount(
    <DecisionCompactCard decision={decision} />,
    true,
  );
  await click(container.querySelector("[data-decision-ask]"));
  const box = container.querySelector<HTMLTextAreaElement>(
    ".cc-cmt-composer textarea",
  )!;
  expect(box).not.toBeNull();
  await type(box, "Why only the cart total?");
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(
    writes().filter(
      (row) =>
        row.action === "commentOnDecision" ||
        row.action === "askDecisionSession",
    ),
  ).toEqual([
    {
      action: "commentOnDecision",
      args: ["d1", "Why only the cart total?", expect.any(String), null],
    },
    { action: "askDecisionSession", args: ["d1", expect.any(String)] },
  ]);
  expect(writes().filter(({ action }) => action === "requestNavigate")).toEqual(
    [{ action: "requestNavigate", args: ["c1"] }],
  );
  expect(store.getState().pendingNavigateId).toBe("c1");
  expect(navigationLog.slice(1)).toEqual([]);
  await unmount();
});
