import { describe, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { pending } from "../../test-helpers/testConvex";
import { mountWeb } from "../../test-helpers/mountWeb";
import { ActionSubmenu } from "../CommandPalette";

async function render(
  teamMembers: { _id: string; name?: string; github_username?: string }[],
  currentUser: { _id: string; name: string } | null,
) {
  const { container } = await mountWeb(
    <ActionSubmenu
      mode="assign"
      targets={[{ _id: "t1", short_id: "ct-1", labels: [] }]}
      targetType="task"
      onClose={() => {}}
      onBack={() => {}}
      teamMembers={teamMembers}
      currentUser={currentUser}
    />,
    { setup: (backend) => backend.set(api.devices.listDevices, pending) },
  );
  return container.innerHTML;
}

describe("assign submenu with a nameless team member", () => {
  test("renders the fallback name instead of crashing", async () => {
    const me = { _id: "u1", name: "Ashot" };
    const nameless = { _id: "u2", github_username: "ghost-dev" };
    const html = await render([me, nameless], me);
    expect(html).toContain("Ashot (you)");
    expect(html).toContain("ghost-dev");
    expect(html).not.toContain("undefined");
  });

  test("a member with no fields at all still gets a label", async () => {
    const html = await render([{ _id: "u3" }], null);
    expect(html).toContain("Unknown");
  });
});
