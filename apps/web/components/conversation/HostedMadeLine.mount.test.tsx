// A hosted receipt's made line ("Set up the routine Morning stretch") with the
// resolver answered by fixtures: a live routine is a link with its state, and
// one deleted since reads as its name from the step, "· Deleted", never the
// machine id the resolver falls back to.
// Run: bun test components/conversation/HostedMadeLine.mount.test.tsx
import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { mountWeb } from "../../test-helpers/mountWeb";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ConvexProvider } from "convex/react";
import { heroConvexStub } from "../../app/(marketing)/heroFly/convexStub";
import {
  EntityFixtureContext,
  type EntityFixture,
} from "../../lib/entityDisplay";
import { HostedMadeLine } from "./HostedMadeLine";

function render(fixtures: Record<string, EntityFixture>) {
  return renderToStaticMarkup(
    <ConvexProvider client={heroConvexStub}>
      <MemoryRouter>
        <EntityFixtureContext.Provider value={fixtures}>
          <HostedMadeLine
            words="Set up the routine"
            name="Weekday morning stretch"
            refId="tr-1448"
          />
        </EntityFixtureContext.Provider>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("HostedMadeLine", () => {
  test("a live routine links by its own name", () => {
    const html = render({
      "tr-1448": {
        type: "trigger",
        entity: {
          _id: "x",
          short_id: "tr-1448",
          display_title: "Morning stretch",
          status: "active",
        },
      },
    });
    expect(html).toContain("Morning stretch</a>");
    expect(html).not.toContain("Deleted");
  });

  test("a paused routine says so after its link", () => {
    const html = render({
      "tr-1448": {
        type: "trigger",
        entity: {
          _id: "x",
          short_id: "tr-1448",
          display_title: "Morning stretch",
          status: "paused",
        },
      },
    });
    expect(html).toContain(" · Paused");
  });

  test("a routine deleted since reads as its name, unlinked, and Deleted", () => {
    const html = render({});
    expect(html).toContain("Weekday morning stretch");
    expect(html).toContain(" · Deleted");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("tr-1448<");
  });
});

test.each(["fixture", "live"] as const)(
  "a %s hosted note uses only its document source",
  async (source) => {
    const id = "x".repeat(32);
    const refId = `doc:${id}`;
    const row = { _id: id, title: "Weekend plan", content: "Pack light" };
    const card = <HostedMadeLine words="Made a note" refId={refId} />;
    const ui = await mountWeb(
      source === "fixture" ? (
        <EntityFixtureContext.Provider
          value={{ [refId]: { type: "doc", entity: row } }}
        >
          {card}
        </EntityFixtureContext.Provider>
      ) : (
        card
      ),
      {
        authenticated: true,
        setup(backend) {
          backend.set(makeFunctionReference<"query">("docs:webGet"), row);
          backend.set(
            makeFunctionReference<"query">("taskMining:webGetDocDetail"),
            row,
          );
        },
      },
    );
    try {
      expect(ui.container.textContent).toContain(row.title);
      expect(ui.container.textContent).toContain(row.content);
      const docQueries = ui.backend.queryRequests
        .map(({ name }) => name)
        .filter(
          (name) =>
            name === "docs:webGet" || name === "taskMining:webGetDocDetail",
        );
      expect(docQueries).toEqual(
        source === "fixture" ? [] : ["taskMining:webGetDocDetail"],
      );
    } finally {
      await ui.close();
    }
  },
);
