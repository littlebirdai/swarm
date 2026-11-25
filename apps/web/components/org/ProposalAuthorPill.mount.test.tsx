import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { test } from "bun:test";
import assert from "node:assert/strict";
import * as React from "react";
import { act } from "react";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { ORG_FIXTURE } from "./orgFixture";
import {
  ProposalAuthorPill,
  DecisionProposalOrigin,
} from "./ProposalAuthorPill";

const fixtures = webBuilders("ProposalAuthorPill.mount.test.tsx");

async function verifyAuthorPill() {
  const session = {
    ...fixtures.session.build({
      _id: "conv-1",
      title: "Org review, September",
    }),
    short_id: "jx7rev1",
  };
  const role = fixtures.role.build({
    _id: "role-1",
    name: "Growth",
    handle: "growth",
    short_id: "or-1",
    avatar: "owl",
  });
  const web = await mountWeb(null, {
    path: "/questions",
    setup(backend, store) {
      store.syncTable("sessions", [session]);
      store.syncTable("orgTree", {
        ...ORG_FIXTURE,
        roles: [role, ...ORG_FIXTURE.roles],
      });
      store.syncTable("clientState", { ui: { show_characters: true } });
      store.syncTable("orgProposals", [
        {
          _id: "p8",
          short_id: "op-8",
          author: { kind: "session", id: session._id },
        },
      ]);
      backend.set(api.orgProposals.origin, ({ proposal }) => {
        if (proposal === "op-9")
          return {
            short_id: "op-9",
            status: "open",
            author: {
              kind: "role",
              id: "role-x",
              name: "Platform",
              handle: "platform",
              short_id: "or-2",
            },
          } as FunctionReturnType<typeof api.orgProposals.origin>;
        if (proposal === "op-500") return new Error("boom");
        return proposal === "op-404" ? null : pending;
      });
    },
  });
  const render = web.rerender;
  const asked = () =>
    web.backend.queryRequests
      .filter(({ name }) => name === "orgProposals:origin")
      .map(({ args }) => args);
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);

  // A role the server named: name, handle, avatar, the scope page link.
  await render(
    React.createElement(ProposalAuthorPill, {
      author: {
        kind: "role",
        id: "role-9",
        name: "Head of People",
        short_id: "or-9",
        handle: "head-of-people",
        avatar: "fox",
      },
    }),
  );
  const rolePill = q<HTMLAnchorElement>('[data-proposal-author="role"]')!;
  assert.equal(rolePill.tagName, "A");
  assert.equal(rolePill.getAttribute("href"), "/org/or-9");
  assert.match(rolePill.textContent!, /Head of People@head-of-people/);
  assert.equal(q("[data-avatar]")!.getAttribute("data-avatar"), "fox");

  // A role only the tree names: filled from the roles hook, its chosen avatar kept.
  await render(
    React.createElement(ProposalAuthorPill, {
      author: { kind: "role", id: "role-1" },
    }),
  );
  assert.equal(
    q<HTMLAnchorElement>('[data-proposal-author="role"]')!.getAttribute("href"),
    "/org/or-1",
  );
  assert.match(
    q('[data-proposal-author="role"]')!.textContent!,
    /Growth@growth/,
  );
  assert.equal(q("[data-avatar]")!.getAttribute("data-avatar"), "owl");

  // A role neither the server nor the tree names: still a pill, no link, and
  // no query of the pill's own.
  await render(
    React.createElement(ProposalAuthorPill, {
      author: { kind: "role", id: "role-x" },
    }),
  );
  assert.equal(q('[data-proposal-author="role"]')!.tagName, "SPAN");
  assert.match(q('[data-proposal-author="role"]')!.textContent!, /a role/);
  assert.deepEqual(asked(), []);

  // A session author: title and short id from the store row; a click opens
  // the conversation through the linked session navigation.
  await render(
    React.createElement(ProposalAuthorPill, {
      author: { kind: "session", id: "conv-1" },
    }),
  );
  const sessionPill = q<HTMLButtonElement>('[data-proposal-author="session"]')!;
  assert.equal(sessionPill.tagName, "BUTTON");
  assert.match(sessionPill.textContent!, /Org review, Septemberjx7rev1/);
  await act(async () => sessionPill.click());
  assert.deepEqual(web.navigationLog.at(-1), {
    action: "push",
    path: "/conversation/conv-1",
  });
  assert.match(sessionPill.title, /Org review, September \(jx7rev1\)/);

  // The pane hands its own opener; the pill uses it instead.
  const own: string[] = [];
  await render(
    React.createElement(ProposalAuthorPill, {
      author: { kind: "session", id: "conv-1" },
      onOpenSession: (id: string) => own.push(id),
    }),
  );
  await act(async () =>
    q<HTMLButtonElement>('[data-proposal-author="session"]')!.click(),
  );
  assert.deepEqual(own, ["conv-1"]);

  // A session the store does not hold still reads as a session and still opens.
  await render(
    React.createElement(ProposalAuthorPill, {
      author: { kind: "session", id: "conv-gone" },
    }),
  );
  assert.match(
    q('[data-proposal-author="session"]')!.textContent!,
    /a session/,
  );

  const gone = q<HTMLButtonElement>('[data-proposal-author="session"]');
  expectPresent(gone);
  await act(async () => gone.click());
  assert.deepEqual(web.navigationLog.at(-1), {
    action: "push",
    path: "/conversation/conv-gone",
  });
  assert.equal(
    typeof web.store.getState().sessions["conv-gone"].updated_at,
    "number",
  );

  // A person.
  await render(
    React.createElement(ProposalAuthorPill, {
      author: { kind: "user", id: "u1", name: "Sam" },
    }),
  );
  assert.equal(q('[data-proposal-author="user"]')!.textContent, "Sam");

  // The decision's origin line: found from `/org?proposal=op-N` in its context,
  // named from the proposal row, linked to the org page. Nothing for other decisions.
  await render(
    React.createElement(DecisionProposalOrigin, {
      contextMd:
        "Summary.\n\n[Open op-8 on the org page](https://codecast.sh/org?proposal=op-8)",
    }),
  );
  const origin = q("[data-proposal-origin]")!;
  assert.equal(origin.getAttribute("data-proposal-origin"), "op-8");
  assert.match(origin.textContent!, /proposed byOrg review, Septemberjx7rev1/);
  assert.equal(
    q<HTMLAnchorElement>('[data-proposal-origin] a[href="/org?proposal=op-8"]')!
      .textContent,
    "op-8",
  );
  assert.deepEqual(asked(), [], "the store held the row, so nothing was asked");
  await render(
    React.createElement(DecisionProposalOrigin, { contextMd: "Ship it?" }),
  );
  expectAbsent(q("[data-proposal-origin]"));
  // Not in the store: one light read names the author (orgProposals.origin), never the full proposal.
  await render(
    React.createElement(DecisionProposalOrigin, {
      contextMd: "[x](/org?proposal=op-9)",
    }),
  );
  assert.equal(
    q("[data-proposal-origin]")!.getAttribute("data-origin-state"),
    "named",
  );
  assert.match(
    q("[data-proposal-origin]")!.textContent!,
    /proposed byPlatform/,
  );
  assert.equal(
    q<HTMLAnchorElement>('[data-proposal-author="role"]')!.getAttribute("href"),
    "/org/or-2",
  );
  assert.deepEqual(asked(), [{ proposal: "op-9" }]);
  // No answer yet says so; an unreadable proposal or a failed read still links the proposal and never waits on a name.
  await render(
    React.createElement(DecisionProposalOrigin, {
      contextMd: "[x](/org?proposal=op-77)",
    }),
  );
  assert.match(q("[data-proposal-origin]")!.textContent!, /looking up op-77/);
  for (const ref of ["op-404", "op-500"]) {
    await render(
      React.createElement(DecisionProposalOrigin, {
        contextMd: `[x](/org?proposal=${ref})`,
      }),
    );
    assert.equal(
      q("[data-proposal-origin]")!.getAttribute("data-origin-state"),
      "unnamed",
    );
    assert.doesNotMatch(
      q("[data-proposal-origin]")!.textContent!,
      /looking up/,
    );
    assert.equal(
      q<HTMLAnchorElement>(
        `[data-proposal-origin] a[href="/org?proposal=${ref}"]`,
      )!.textContent,
      ref,
    );
  }

  await web.close();
}

test("shows who proposed a change and links to the proposal", verifyAuthorPill);
