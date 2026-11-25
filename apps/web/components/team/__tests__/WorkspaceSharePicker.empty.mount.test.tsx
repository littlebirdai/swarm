import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { CLI_CONNECTED_KEY } from "../../../lib/cliConnected";
import { WorkspaceSharePicker } from "../WorkspaceSharePicker";

const data: ComponentProps<typeof WorkspaceSharePicker>["data"] = {
  suggestions: null,
  allProjects: [],
  suggestedPaths: new Set(),
  matched: [],
  other: [],
  teamName: "Littlebird",
  teamOnlyRepos: [],
  getSuggestion: () => undefined,
};

const mount = (justConnected = false) =>
  mountWeb(
    <WorkspaceSharePicker
      data={data}
      teamId={null}
      selectedPaths={{}}
      onToggle={() => {}}
    />,
    {
      path: "/settings/team/join",
      setup: () => {
        if (justConnected)
          sessionStorage.setItem(CLI_CONNECTED_KEY, String(Date.now()));
      },
    },
  );

test("a joiner with no synced machine is offered the one-step setup", async () => {
  const { container } = await mount();
  expect(container.textContent).toContain("Connect this machine first");
  expect(container.textContent).toContain("Generate install command");
  expect(container.textContent).not.toContain("cast auth");
});

test("a machine that just connected waits for sessions instead of installing again", async () => {
  const { container } = await mount(true);
  expect(container.textContent).toContain("Waiting for your first sessions");
  expect(container.textContent).not.toContain("Generate install command");
});
