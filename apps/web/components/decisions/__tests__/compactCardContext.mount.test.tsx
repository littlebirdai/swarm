import { api } from "@codecast/convex/convex/_generated/api";
import { afterEach, expect, spyOn, test } from "bun:test";
import { act, type ComponentProps, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  useInboxStore,
  type SessionDecisionItem,
} from "../../../store/inboxStore";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import * as markdown from "../../tools/MarkdownRenderer";
import { DecisionCompactCard } from "../DecisionCompactCard";

let renderer: ReturnType<typeof observeRenderer> | undefined;
function observeRenderer() {
  const Render = markdown.MarkdownRenderer;
  const callable: {
    MarkdownRenderer: (props: ComponentProps<typeof Render>) => ReactNode;
  } = markdown;
  return spyOn(callable, "MarkdownRenderer").mockImplementation((props) => (
    <Render {...props} />
  ));
}
afterEach(() => {
  renderer?.mockRestore();
  renderer = undefined;
});

const decision: SessionDecisionItem = {
  _id: "d1",
  short_id: "sd-95",
  conversation_id: "c1",
  session_id: "s1",
  question: "Ship the address keyed bounce guard and run the backfill?",
  context_md:
    "## What happened\n\nA contact gave us a **new** address on a call.\n\nThe bounce on the old one still blocks them.",
  options: [
    {
      label: "Ship it and run the backfill",
      description: "clears the stale flag on 110 contacts",
    },
    {
      label: "Ship it, hold the backfill",
      description: "the code path is fixed from now on",
    },
  ],
  blocking: true,
  status: "pending",
  kind: "single",
  created_at: Date.now() - 60_000,
};

type Seed = (store: ReturnType<typeof useInboxStore.getState>) => void;

async function mount(ui: ReactNode, seed?: Seed) {
  const web = await mountWeb(ui, {
    path: "/questions",
    dispatch: true,
    setup(backend, store) {
      seed?.(store);
      backend.set(api.sessionDecisions.getWithDoc, pending);
      backend.set(api.sessionDecisions.get, pending);
      backend.set(api.orgProposals.origin, pending);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  return { ...web, unmount: web.close };
}

test("the context renders inline, as stripped text while collapsed", async () => {
  renderer = observeRenderer();
  const { container, unmount } = await mount(
    <DecisionCompactCard decision={decision} />,
  );
  const body = container.querySelector("[data-decision-context]")!;
  expect(body).not.toBeNull();
  // The reasoning is on the card, not only on the document page.
  expect(body.textContent).toContain(
    "A contact gave us a new address on a call",
  );
  // Collapsed: the heading marks and the bold marks are gone, and the
  // markdown renderer never ran.
  expect(body.textContent).not.toContain("##");
  expect(body.textContent).not.toContain("**");
  expect(renderer).not.toHaveBeenCalled();
  await unmount();
});

test("a context holding a canvas renders it while collapsed, never its raw HTML as text", async () => {
  renderer = observeRenderer();
  const context_md =
    '```cast-canvas\n<div data-canvas-title="Options"><b>A</b> vs <b>B</b></div>\n```\n\nWhy it matters.';
  const { container, unmount } = await mount(
    <DecisionCompactCard decision={{ ...decision, context_md }} />,
  );
  expect(renderer.mock.calls.map(([props]) => props.content)).toEqual([
    context_md,
  ]);
  const body = container.querySelector("[data-decision-context]");
  expectPresent(body);
  expect(body.textContent).not.toContain("<b>A</b>");
  expect(body.textContent).toContain("Why it matters.");
  const canvas = [...body.querySelectorAll("*")].find(
    (element) => element.shadowRoot,
  );
  expect(
    canvas?.shadowRoot?.querySelector("[data-canvas-title]")?.textContent,
  ).toBe("A vs B");
  await unmount();
});

test("the question is set in the document page's serif, and a blocking card is the call to action", async () => {
  const { container, unmount } = await mount(
    <DecisionCompactCard decision={decision} cta />,
  );
  const card = container.querySelector("[data-decision-card]")!;
  expect(card.classList.contains("decision-card")).toBe(true);
  expect(card.getAttribute("data-cta")).toBe("true");
  expect(container.querySelector(".decision-question")!.textContent).toContain(
    "bounce guard",
  );
  await unmount();
});

test("a card with no context renders no body at all", async () => {
  const { container, unmount } = await mount(
    <DecisionCompactCard decision={{ ...decision, context_md: undefined }} />,
  );
  expectAbsent(container.querySelector("[data-decision-context]"));
  await unmount();
});

test("a decision asked of somebody else names them, and an answer here lands on a store row", async () => {
  // Read by id from the transcript: no queue row, only the detail.
  const other = { ...decision, _id: "d-other", short_id: "sd-96" };
  const { container, unmount } = await mount(
    <DecisionCompactCard decision={other} askedOf="Cam" />,
    (store) => {
      store.syncTable("currentUser", { _id: "me" });
      store.syncTable("decisionDetails", [
        {
          _id: other._id,
          decision: other,
          doc: null,
          task: null,
          stack: null,
          ladder: [],
          asked_users: [{ _id: "cam", name: "Cam" }],
          holder_role: null,
          grant_offer: null,
          grant: null,
        },
      ]);
    },
  );
  expect(container.querySelector("[data-decision-asked-of]")!.textContent).toBe(
    "for Cam",
  );
  const first = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Ship it and run the backfill"),
  )!;
  await act(() =>
    first.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  const row = useInboxStore.getState().sessionDecisions["d-other"];
  expect(row?.status).toBe("answered");
  expect(row?.answer_index).toBe(0);
  await unmount();
});

test("the card's serif question and the call to action tint are defined in the stylesheet", () => {
  const css = readFileSync(
    join(import.meta.dir, "..", "decisions.css"),
    "utf8",
  );
  expect(css).toMatch(
    /\.decision-card \.decision-question\s*\{[^}]*font-family:\s*var\(--font-serif\)/,
  );
  expect(css).toMatch(/\.decision-card\[data-cta="true"\]/);
});
