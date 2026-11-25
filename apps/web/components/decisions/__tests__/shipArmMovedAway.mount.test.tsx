import { expect, test } from "bun:test";
import { act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  CARD_DECISION_OPTIONS,
  type ChangeCard,
} from "@codecast/line/changeCard";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { testToasts } from "../../../test-helpers/testToasts";
import { waitForPopupClose } from "../../../test-helpers/waitForPopupClose";
import type { SessionDecisionItem } from "../../../store/inboxStore";
import { DecisionAnswerControls } from "../DecisionAnswerControls";

const card: ChangeCard = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../../../packages/line/test/__fixtures__/changeCard/card.json",
    ),
    "utf-8",
  ),
);
const realCard = (id: string): SessionDecisionItem => ({
  _id: id,
  conversation_id: "c1",
  session_id: "s1",
  question: `Decision ${id}`,
  options: CARD_DECISION_OPTIONS.map((o) => ({ ...o })),
  blocking: true,
  status: "pending",
  created_at: 0,
  card: { ...card, cause: { ...card.cause, title: `Decision ${id}` } },
  task_id: `t-${id}`,
  workflow_run_id: `r-${id}`,
});

async function mountCards(ids: string[], { keys = false, line = true } = {}) {
  const cards = ids.map(realCard);
  const web = await mountWeb(
    <>
      {cards.map((decision) => (
        <section key={decision._id} data-card={decision._id}>
          <DecisionAnswerControls
            decision={decision}
            onAnswer={() => {}}
            keys={keys}
            size={line ? "line" : "full"}
          />
        </section>
      ))}
    </>,
    {
      clock: !line,
      path: "/questions",
      dispatch: true,
      setup: (backend, store) => {
        store.syncTable("sessionDecisions", cards);
        backend.mutation(api.dispatch.dispatch, null);
      },
    },
  );
  const shipOf = (id: string) =>
    web.container.querySelector<HTMLButtonElement>(
      `[data-card=${id}] [data-verdict=ship]`,
    )!;
  const ships = () =>
    web.backend.mutations.filter(
      ({ args }) =>
        args &&
        typeof args === "object" &&
        "action" in args &&
        args.action === "startShip",
    );
  return { shipOf, ships, clock: web.clock! };
}

const review = () => document.querySelector("[data-switch-review=Ship]");
const key = (value: string, init: KeyboardEventInit = {}) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });

test("one Ship press on a real flow card, then moving to the next decision, is never silently dropped", async () => {
  const { shipOf, ships, clock } = await mountCards(["d1", "d2"], {
    line: false,
  });
  const toasts = testToasts();
  await act(() => {
    shipOf("d1").focus();
    shipOf("d1").click();
  });
  expect(ships()).toHaveLength(0);
  await act(() => shipOf("d2").focus());
  await clock.advance(20);
  const confirmStillOpen =
    review()?.querySelector("[data-switch-subject]")?.textContent ===
    "Decision d1";
  const noticeShown = toasts
    .events()
    .some(
      ({ event, kind, title }) =>
        event !== "dismiss" &&
        (kind === "info" || kind === "warning" || kind === "error") &&
        !/sent/i.test(String(title)),
    );
  const shipStarted = ships().some(
    ({ args }) =>
      args &&
      typeof args === "object" &&
      "args" in args &&
      Array.isArray(args.args) &&
      args.args[2] === "d1",
  );
  expect({ shipStarted, confirmStillOpen, noticeShown }).not.toEqual({
    shipStarted: false,
    confirmStillOpen: false,
    noticeShown: false,
  });
  await toasts.clear();
});

test("one Ship press on each of three real cards in a row ships none and says nothing was sent", async () => {
  const { ships, shipOf } = await mountCards(["a1", "a2", "a3"]);
  const toasts = testToasts();
  for (const id of ["a1", "a2", "a3"]) {
    await act(() => {
      shipOf(id).focus();
      shipOf(id).click();
    });
    expect(review()).not.toBeNull();
    await key("Escape");
    await waitForPopupClose();
    expect(review()).toBeNull();
  }
  expect(ships()).toHaveLength(0);
  expect(toasts.events().some(({ title }) => /sent/i.test(String(title)))).toBe(
    false,
  );
  await toasts.clear();
});

test("Ship's digit opens confirmation, its chord ships once, and Escape sends nothing", async () => {
  const { ships, shipOf } = await mountCards(["k1"], { keys: true });
  await act(() => shipOf("k1").focus());
  await key("1");
  await key("Enter");
  expect(review()).not.toBeNull();
  expect(ships()).toHaveLength(0);
  await key("Escape");
  await waitForPopupClose();
  expect(review()).toBeNull();
  expect(ships()).toHaveLength(0);

  const toasts = testToasts();
  await key("1");
  await key("Enter");
  await key("Enter", { ctrlKey: true });
  await waitForPopupClose();
  expect(ships()).toEqual([
    {
      name: "dispatch:dispatch",
      args: expect.objectContaining({
        action: "startShip",
        args: [{ kind: "task", id: "t-k1" }, expect.any(String), "k1"],
      }),
    },
  ]);
  expect(review()).toBeNull();
  expect(toasts.events()).toEqual([
    {
      event: "show",
      id: expect.any(Number),
      kind: "success",
      title: "Ship sent",
    },
  ]);
  await toasts.clear();
});
