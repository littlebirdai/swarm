import { describe, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { Command as CommandPrimitive } from "cmdk";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { TeammateItem } from "../CommandPalette";

const NOW = Date.now();

async function render(
  row: Parameters<typeof TeammateItem>[0]["row"],
  following = false,
) {
  const { container, close } = await mountWeb(
    <CommandPrimitive>
      <CommandPrimitive.List>
        <TeammateItem
          row={row}
          className="row"
          onOpen={() => {}}
          following={following}
        />
      </CommandPrimitive.List>
    </CommandPrimitive>,
    {
      setup: (backend) =>
        backend.set(api.conversations.getConversation, pending),
    },
  );
  const html = container.innerHTML;
  await close();
  return html;
}

const ann = { _id: "u-ann", name: "Ann", presence_state: "active" };

describe("palette Teammates row", () => {
  test("a teammate in a session: their name, the session title, how long they have been there", async () => {
    const html = await render({
      member: ann,
      id: "u-ann",
      name: "Ann",
      conversationId: "c1",
      title: "Fix the auth race",
      inStore: true,
      online: true,
      since: NOW - 5 * 60_000,
      score: 0,
    });
    expect(html).toContain(">Ann<");
    expect(html).not.toContain("Follow");
    expect(html).toContain("Fix the auth race");
    expect(html).toContain("for 5m");
    expect(html).toContain('data-palette-type="person"');
    expect(html).toContain('data-palette-id="u-ann"');
    expect(html).not.toContain('aria-disabled="true"');
  });

  test("a session the store lacks is named plainly until its row arrives", async () => {
    const html = await render({
      member: ann,
      id: "u-ann",
      name: "Ann",
      conversationId: "c".repeat(32),
      title: undefined,
      inStore: false,
      online: true,
      since: NOW,
      score: 0,
    });
    expect(html).toContain(">Ann<");
    expect(html).toContain("a session");
    expect(html).not.toContain("for ");
  });

  test("a teammate around but in no session, or offline, says so under the name", async () => {
    const base = {
      member: ann,
      id: "u-ann",
      name: "Ann",
      conversationId: null,
      title: undefined,
      inStore: false,
      since: undefined,
      score: 1,
    };
    const around = await render({ ...base, online: true });
    expect(around).toContain("around, not in a session");
    expect(around).toContain('aria-disabled="false"');
    expect(await render({ ...base, online: false })).toContain("offline");
  });

  test("a teammate this window already follows says so", async () => {
    const html = await render(
      {
        member: ann,
        id: "u-ann",
        name: "Ann",
        conversationId: null,
        inStore: false,
        online: true,
        score: 0,
        title: undefined,
        since: undefined,
      },
      true,
    );
    expect(html).toContain("following · around, not in a session");
  });
});
