import { test } from "bun:test";
import assert from "node:assert/strict";
import { api } from "@codecast/convex/convex/_generated/api";
import { act } from "react";
import type { RoleRecipient } from "../lib/roleRecipients";
import { webBuilders } from "../test-helpers/builders";
import { expectAbsent, expectPresent } from "../test-helpers/domExpect";
import { mountWeb } from "../test-helpers/mountWeb";
import { pending } from "../test-helpers/testConvex";
import { ComposeRolePicker } from "./ComposeRolePicker";
import { ORG_FIXTURE } from "./org/orgFixture";
import type { OrgRole } from "./org/orgTypes";

test("the role picker filters, selects, and respects composer focus", async () => {
  const { role, conversation, teamMember } = webBuilders(
    "ComposeRolePicker.mount.test.tsx",
  );
  const viewer = teamMember.build();
  const sam = teamMember.build();
  const team = teamMember.build()._id;
  const base = {
    scope_type: "team",
    team_id: team,
    host_user_id: viewer._id,
  } satisfies Partial<OrgRole>;
  const standing = () => {
    const row = conversation.build();
    return { conversation_id: row._id, short_id: row.short_id ?? "jx7stand" };
  };
  const platform = role.build({
    ...base,
    handle: "platform",
    name: "Platform lead",
    given_name: "Sol",
    reports_to: { kind: "user", user_id: sam._id },
    status: "paused",
    standing: standing(),
  });
  const growth = role.build({
    ...base,
    handle: "growth",
    name: "Head of Growth",
    given_name: "Ember",
    reports_to: { kind: "user", user_id: viewer._id },
    standing: standing(),
    scope_names: {
      projects: [{ id: "p1", title: "Growth", short_id: "pr-1" }],
      plans: [{ id: "l1", title: "SEO", short_id: "pl-1" }],
    },
  });
  const docs = role.build({
    ...base,
    handle: "docs",
    name: "Docs lead",
    given_name: "Ada",
    reports_to: { kind: "role", role_id: platform._id },
    standing: null,
  });
  const people = role.build({
    ...base,
    handle: "head-of-people",
    name: "Head of People",
    given_name: "Rowan",
    reports_to: { kind: "user", user_id: viewer._id },
    standing: standing(),
  });
  const picks: Array<string | null> = [];
  let done = 0;
  let picked: RoleRecipient | null = null;
  const pane = () => (
    <div role="dialog" aria-modal="true">
      <ComposeRolePicker
        picked={picked}
        onPick={(recipient) => {
          picks.push(recipient?.standingId ?? null);
          picked = recipient;
        }}
        onDone={() => {
          done += 1;
        }}
      />
      <textarea id="msg" />
    </div>
  );
  const web = await mountWeb(pane(), {
    setup(backend, store) {
      store.syncTable("currentUser", viewer);
      store.syncTable("clientState", {
        ui: { active_team_id: team, show_characters: true },
      });
      store.syncTable("orgTree", {
        ...ORG_FIXTURE,
        workspace: { kind: "team", id: team, name: "Fernhill" },
        roles: [platform, growth, docs, people],
      });
      backend.set(api.org.roles, pending);
    },
  });
  const render = () => web.rerender(pane());
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(sel));
  const handleOf = (el: Element) => `@${el.getAttribute("data-handle")}`;
  const key = (target: EventTarget, init: KeyboardEventInit) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
  const typeInto = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  await render();
  assert.equal(qa("button").length, 0);
  expectAbsent(q("input"));

  await key(window, { altKey: true, code: "KeyR", key: "®" });
  const input = q<HTMLInputElement>("input")!;
  expectPresent(input, "the filter input mounted");
  assert.equal(document.activeElement, input);
  const rows = qa("[role=option] button");
  assert.deepEqual(rows.map(handleOf), [
    "@growth",
    "@head-of-people",
    "@docs",
    "@platform",
  ]);
  assert.match(rows[0].textContent!, /EmberHead of Growth· Growth, SEO$/);
  assert.ok(
    !rows[0].className.includes("opacity-70"),
    "my own role reads in full",
  );
  assert.ok(
    rows[2].className.includes("opacity-70"),
    "another person's role is quieter",
  );
  assert.ok(
    (rows[2] as HTMLButtonElement).disabled,
    "no standing session: not pickable",
  );
  assert.match(rows[2].textContent!, /no agent yet/);
  assert.match(rows[3].textContent!, /paused/);
  assert.match(q("[role=listbox]")!.textContent!, /Other people’s roles/);

  assert.equal(qa("[role=option][aria-selected=true]").length, 1);
  assert.equal(
    qa("[role=option][aria-selected=true] button")[0].getAttribute(
      "data-handle",
    ),
    "growth",
  );
  await key(input, { key: "ArrowDown" });
  await key(input, { key: "ArrowDown" });
  assert.equal(
    qa("[role=option][aria-selected=true] button")[0].getAttribute(
      "data-handle",
    ),
    "platform",
  );

  await typeInto(input, "gro");
  assert.deepEqual(qa("[role=option] button").map(handleOf), ["@growth"]);
  await key(input, { key: "Enter" });
  assert.deepEqual(picks, [growth.standing!.conversation_id]);
  assert.equal(done, 1);
  await render();
  expectAbsent(q("input"));
  assert.match(
    q("[aria-label^='Sending to Ember']")!.textContent!,
    /EmberHead of Growth· Growth, SEO@growth/,
  );
  await key(window, { altKey: true, code: "KeyR" });
  await typeInto(q("input")!, "@head");
  assert.deepEqual(qa("[role=option] button").map(handleOf), [
    "@head-of-people",
    "@growth",
  ]);
  assert.match(qa("[role=option] button")[0].textContent!, /@head-of-people$/);
  await key(q("input")!, { key: "Escape" });
  await render();

  await key(window, { altKey: true, code: "KeyR" });
  assert.ok(q("input"));
  await key(q("input")!, { key: "Escape" });
  assert.equal(done, 3);
  await render();
  expectAbsent(q("input"));
  assert.ok(q("[aria-label^='Sending to Ember']"));

  const confirm = document.createElement("div");
  confirm.setAttribute("aria-modal", "true");
  document.body.appendChild(confirm);
  await key(window, { altKey: true, code: "KeyR" });
  expectAbsent(q("input"));
  confirm.remove();

  await act(async () =>
    q<HTMLButtonElement>(
      "[aria-label='Start a fresh session instead']",
    )!.click(),
  );
  assert.deepEqual(picks, [growth.standing!.conversation_id, null]);
  await render();
  assert.equal(qa("button").length, 0);

  const host = (wrap: { role?: string }) =>
    web.rerender(
      <div {...wrap}>
        <ComposeRolePicker picked={null} onPick={() => {}} onDone={() => {}} />
        <textarea id="msg" />
      </div>,
    );
  await host({});
  await key(window, { altKey: true, code: "KeyR" });
  assert.ok(q("input"), "⌥R opens the picker on the new-session page");
  await key(q("input")!, { key: "Escape" });
  await host({ role: "dialog" });
  (document.activeElement as HTMLElement | null)?.blur();
  await key(window, { altKey: true, code: "KeyR" });
  assert.equal(q("input"), null, "an unfocused dock ignores ⌥R");
  await act(async () => q<HTMLTextAreaElement>("#msg")!.focus());
  await key(window, { altKey: true, code: "KeyR" });
  assert.ok(q("input"), "a focused dock opens on ⌥R");
});
