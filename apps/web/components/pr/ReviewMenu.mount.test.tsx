import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { makeFunctionReference, type FunctionArgs } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type { SendOutcome } from "@codecast/comments";
import { mountWeb } from "../../test-helpers/mountWeb";
import { testToasts } from "../../test-helpers/testToasts";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import { ReviewMenu } from "./PRActions";

const pr = {
  _id: "pr_1",
  repository: "codecast-sh/codecast",
  number: 12,
  state: "open",
  shepherd_conversation_id: "conv_1",
  author_github_username: "sam",
};
const notes = [
  {
    _id: "n1",
    file_path: "src/a.ts",
    line_number: 4,
    content: "rename this",
    created_at: 1,
  },
  {
    _id: "n2",
    file_path: "src/b.ts",
    line_number: 9,
    content: "test this",
    created_at: 2,
  },
];

type HandReply = {
  sent: number;
  conversation_id: string;
  short_id?: string;
  outcome?: SendOutcome;
};

const hand = makeFunctionReference<
  "mutation",
  FunctionArgs<typeof api.reviews.handPendingToSession>,
  HandReply
>("reviews:handPendingToSession");

function Menu() {
  const [open, setOpen] = useState(true);
  return (
    <ReviewMenu
      pr={pr}
      notes={notes}
      authorLogin="ashot"
      onNavigate={() => {}}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

async function mount(reply: HandReply | Error) {
  const web = await mountWeb(<Menu />, {
    dispatch: true,
    expectedConsoleErrors:
      reply instanceof Error
        ? [/reviews:handPendingToSession.*No session matches conv_1/]
        : [],
    setup: (backend, store) => {
      store.syncTable("codeComments", notes);
      backend.mutation(hand, reply);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  const notices = testToasts();
  return {
    ...web,
    toasts: () =>
      notices.events().map(({ kind, title }) => ({ kind, text: title })),
    handCalls: () =>
      web.backend.mutations.filter(
        ({ name }) => name === "reviews:handPendingToSession",
      ),
  };
}

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(text),
  )!;
const press = (element: Element) =>
  act(async () => {
    (element as HTMLElement).click();
  });

describe("Review popover: send to session", () => {
  test("a plain send carries no resolve flag and an old backend's answer still reads as sent", async () => {
    const { handCalls, toasts } = await mount({
      sent: 2,
      conversation_id: "conv_1",
      short_id: "jx7abcd",
    });
    await press(button("Send to session"));
    await waitForPopupClose();
    expect(handCalls()).toHaveLength(1);
    expect(handCalls()[0]?.args).toEqual({ pull_request_id: pr._id });
    expect(toasts()).toEqual([
      { kind: "success", text: "2 notes sent to jx7abcd" },
    ]);
  });

  test("and resolve: the choice rides the send and the outcome is shown", async () => {
    const { handCalls, toasts } = await mount({
      sent: 2,
      conversation_id: "conv_1",
      short_id: "jx7abcd",
      outcome: {
        kind: "sent_and_resolved",
        sent_ids: ["n1", "n2"],
        waiting: "busy",
      },
    });
    const toggle = document.querySelector("[data-pr-hand-resolve]")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await press(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await press(button("Send to session"));
    await waitForPopupClose();
    expect(handCalls().map(({ args }) => args)).toEqual([
      {
        pull_request_id: "pr_1",
        resolve: true,
      },
    ]);
    expect(toasts()).toEqual([
      {
        kind: "success",
        text: "2 notes sent to jx7abcd, queued until its turn ends and resolved",
      },
    ]);
  });

  test("a failed send stays on screen with a retry, never a clipboard fallback", async () => {
    const { backend, handCalls, toasts } = await mount(
      new Error("No session matches conv_1"),
    );
    await press(button("Send to session"));
    const row = document.querySelector("[data-pr-hand-outcome]")!;
    expect(row.getAttribute("data-pr-hand-outcome")).toBe("failed");
    expect(row.querySelector("span")?.textContent).toBe(
      "Not sent: [CONVEX M(reviews:handPendingToSession)] Error: No session matches conv_1\n  Called by client",
    );
    expect(toasts()).toEqual([]);

    backend.mutation(hand, {
      sent: 2,
      conversation_id: "conv_1",
      outcome: { kind: "sent", sent_ids: ["n1", "n2"] },
    });
    await press(document.querySelector("[data-pr-hand-retry]")!);
    await waitForPopupClose();
    expect(handCalls()).toHaveLength(2);
    await press(button("Review · 2"));
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    expect(document.querySelector("[data-pr-hand-outcome]")).toBeNull();
    expect(toasts()).toEqual([
      { kind: "success", text: "2 notes sent to the session" },
    ]);
  });

  test("a resolve that left notes open resolves just those on retry", async () => {
    const { backend, handCalls, toasts } = await mount({
      sent: 2,
      conversation_id: "conv_1",
      outcome: {
        kind: "resolve_failed",
        sent_ids: ["n1", "n2"],
        open_ids: ["n2"],
        reason: "write conflict",
      },
    });
    await press(document.querySelector("[data-pr-hand-resolve]")!);
    await press(button("Send to session"));
    expect(
      document.querySelector("[data-pr-hand-outcome]")!.textContent,
    ).toContain("1 note still open: write conflict");
    await press(button("Resolve again"));
    await waitForPopupClose();
    expect(
      backend.mutations.filter(({ name }) => name === "dispatch:dispatch"),
    ).toEqual([
      {
        name: "dispatch:dispatch",
        args: {
          ack_positions: true,
          action: "resolveCodeCommentThread",
          args: [["n2"], true],
          patches: {},
          result: null,
        },
      },
    ]);
    expect(handCalls()).toHaveLength(1);
    expect(toasts()).toEqual([
      { kind: "success", text: "2 notes sent to the session and resolved" },
    ]);
  });
});
