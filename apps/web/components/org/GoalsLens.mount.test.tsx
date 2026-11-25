import { ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import { expect, test } from "bun:test";
import { act, type ComponentType } from "react";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { standInForOrgGraph } from "../../test-helpers/orgGraphStandIn";
import {
  CompanyCard,
  GoalCard,
  GoalOwnerCard,
  GoalProjectCard,
} from "./GoalsNodeCards";
import { GOALS_FIXTURE_CHANGES, GOALS_FIXTURE_DATA } from "./goalsFixture";
import {
  goalNodeId,
  layoutGoals,
  projectNodeId,
  type GoalsNode,
} from "./goalsLayout";
import { ORG_FIXTURE } from "./orgFixture";
import { personNodeId, roleNodeId } from "./orgLayout";
import { OrgMap } from "./OrgMap";

const q = (sel: string, root: ParentNode = document) =>
  root.querySelector<HTMLElement>(sel);

test("goal, project and owner cards wear the proposal's ghost chrome", async () => {
  const layout = layoutGoals({
    tree: ORG_FIXTURE,
    ...GOALS_FIXTURE_DATA,
    changes: GOALS_FIXTURE_CHANGES,
  });
  const node = <Kind extends GoalsNode["kind"]>(kind: Kind, id: string) => {
    const candidate = layout.nodes.find(
      (n): n is Extract<GoalsNode, { kind: Kind }> =>
        n.id === id && n.kind === kind,
    );
    expect(candidate).toBeDefined();
    return candidate!;
  };
  const focused: string[] = [];
  function card<Data extends Record<string, unknown>>(
    Component: ComponentType<NodeProps<Node<Data>>>,
    { id, kind }: GoalsNode,
    data: Data,
  ) {
    return (
      <div data-card={id} key={id}>
        <Component
          id={id}
          type={kind}
          selected={false}
          dragging={false}
          zIndex={0}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          draggable={false}
          selectable={false}
          deletable={false}
          data={data}
        />
      </div>
    );
  }
  const goal = (id: string) => {
    const n = node("goal", goalNodeId(id));
    return card(GoalCard, n, {
      ...n,
      focusChangeId: null,
      onFocusChange: (changeId: string) => focused.push(changeId),
    });
  };
  const project = (g: string, p: string) => {
    const n = node("project", projectNodeId(g, p));
    return card(GoalProjectCard, n, { project: n.project });
  };
  const owner = (id: string) => {
    const n = node("owner", id);
    return card(GoalOwnerCard, n, { owner: n.owner, owns: n.owns });
  };
  const company = node("company", "company");

  const { container: el, close } = await mountWeb(
    <ReactFlowProvider>
      {card(CompanyCard, company, { ...company, mission: false })}
      {goal("init-org")}
      {goal("g-new")}
      {goal("init-org-sub")}
      {goal("init-orphan")}
      {goal("init-revenue")}
      {project("init-revenue", "proj-org")}
      {project("init-org", "proj-inbox")}
      {owner(roleNodeId("fixture-role-growth"))}
      {owner(personNodeId("fixture-user-sam"))}
    </ReactFlowProvider>,
  );
  const cardOf = (id: string) => q(`[data-card='${id}']`, el)!;

  expect(cardOf("company").textContent).toContain("Codecast");
  expect(q("[data-company-tally]", el)!.textContent).toBe(
    "5 goals · 3 projects",
  );
  // A live goal: no ghost chrome, its health in words.
  const live = cardOf(goalNodeId("init-org"));
  expectPresent(q("[data-org-node='goal']", live));
  expectAbsent(q("[data-ghost-tag]", live));
  expectPresent(q("[data-initiative-health='at_risk']", live));
  // A new goal wears one quiet mark: a thin solid outline over a tint, its tag
  // a plain word, its metrics a plain line. Nothing on the card is dashed.
  const fresh = cardOf(goalNodeId("g-new"));
  expect(q("[data-org-node='goal-ghost']", fresh)!.style.border).toContain(
    "solid",
  );
  expect(q("[data-ghost-tag]", fresh)!.style.border).toBe("");
  expect(fresh.innerHTML).not.toContain("dashed");
  // The project it would carry is drawn under the live goal that carries it today: one quiet line here naming it.
  expect(q("[data-project-refs]", fresh)!.getAttribute("title")).toContain(
    "drawn under The role page is the session page",
  );
  expect(q("[data-project-refs]", fresh)!.textContent).toContain("also ");
  expectPresent(q("[data-goal-projects='1']", fresh));
  expect(q("[data-ghost-chip='g-new']", fresh)!.textContent).toBe(
    "Teams with a head of people → 40",
  );
  // A placed goal says where it was.
  const placed = cardOf(goalNodeId("init-org-sub"));
  expectPresent(q("[data-ghost-tag]", placed));
  expect(q("[data-goal-was]", placed)!.textContent).toBe(
    "was under Agents run the company's routine work",
  );
  // A named owner and new metrics are chips on a goal that keeps its plain frame.
  expect(
    q("[data-ghost-chip='g-owner']", cardOf(goalNodeId("init-orphan")))!
      .textContent,
  ).toBe("owner Samvit Jain");
  expect(
    q("[data-org-node='goal']", cardOf(goalNodeId("init-revenue"))),
  ).not.toBeNull();
  expect(
    q("[data-ghost-chip='g-measure']", cardOf(goalNodeId("init-revenue")))!
      .textContent,
  ).toContain("Paying teams");
  // Projects: one it carries, one a change adds, one nobody leads.
  // proj-org under init-org is folded: a goal feeding it carries it too. A live row wears no tag.
  expect(
    layout.nodes.some((n) => n.id === projectNodeId("init-org", "proj-org")),
  ).toBe(false);
  expect(
    q("[data-ghost-tag]", cardOf(projectNodeId("init-org", "proj-inbox"))),
  ).toBeNull();
  expect(
    q(
      "[data-ghost-tag='added']",
      cardOf(projectNodeId("init-revenue", "proj-org")),
    ),
  ).not.toBeNull();
  // The middle card names no lead; the close card does (orgZoom), and jsdom sits at zoom 1.
  expect(
    q("[data-project-lead]", cardOf(projectNodeId("init-org", "proj-inbox"))),
  ).toBeNull();
  // Owners: the role by its handle with what it owns, the person by name.
  expect(cardOf(roleNodeId("fixture-role-growth")).textContent).toContain(
    "@growth",
  );
  expect(cardOf(roleNodeId("fixture-role-growth")).textContent).toMatch(
    /owns \d+/,
  );
  expect(cardOf(personNodeId("fixture-user-sam")).textContent).toContain(
    "Samvit Jain",
  );
  // A chip click focuses its change.
  await act(async () => {
    q("[data-ghost-chip='g-owner']", el)!.click();
  });
  expect(focused).toEqual(["g-owner"]);
  await close();
});

test("the map lights the change a card in the conversation points at, and pans only when it is off screen", async () => {
  const graph = standInForOrgGraph();
  try {
    const map = (highlightChangeId: string | null) => (
      <OrgMap
        tree={ORG_FIXTURE}
        goals={GOALS_FIXTURE_DATA}
        proposal={{ changes: GOALS_FIXTURE_CHANGES }}
        filter="everything"
        asProposed
        onAsProposed={() => {}}
        highlightChangeId={highlightChangeId}
      />
    );
    const { container, rerender, close } = await mountWeb(map(null));
    expect(graph.last().focusTarget).toBeNull();
    expect(graph.last().changes?.map((change) => change._id)).toEqual([
      "g-new",
      "g-place",
      "g-projects",
      "g-owner",
      "g-measure",
    ]);
    await rerender(map("g-owner"));
    const target = graph.last().focusTarget;
    expect(target).toMatchObject({
      kind: "change",
      id: "g-owner",
      ifHidden: true,
    });
    expect(graph.last().focusChangeId).toBe("g-owner");
    await rerender(map("g-owner"));
    expect(graph.last().focusTarget).toBe(target);
    await rerender(map(null));
    expect(graph.last().focusTarget).toBeNull();
    expectPresent(q("[data-map-filter='everything']", container));
    expectPresent(q("[data-map-proposed='on']", container));
    await close();
  } finally {
    graph.restore();
  }
});
