import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import type { DeployFocus } from "../../../lib/deploys/focus";
import { FocusChip } from "../DeploysPage";

const CONVERSATION_ID = "jx7b0m0k4q2v9d8h3s6n1p5r7t2w8y4z";

const mount = (focus: DeployFocus, onClear = () => {}) =>
  mountWeb(
    <FocusChip
      focus={focus}
      waiting
      deploys={[]}
      live={null}
      onClear={onClear}
    />,
    { setup: (backend) => backend.set(api.conversations.webGet, pending) },
  );

test("a session named by its conversation id reads as its short id, in a session pill", async () => {
  let cleared = 0;
  const { container: host } = await mount(
    { kind: "session", id: CONVERSATION_ID },
    () => cleared++,
  );
  const chip = host.querySelector(".dpp-focus")!;
  expect(chip.textContent).toContain("jx7b0m0");
  expect(chip.textContent).not.toContain(CONVERSATION_ID);
  expect(chip.querySelector(`a[href*="${CONVERSATION_ID}"]`)).not.toBeNull();
  await act(() =>
    (
      chip.querySelector("[data-deploy-focus-clear]") as HTMLButtonElement
    ).click(),
  );
  expect(cleared).toBe(1);
});

test("a session already named by its short id reads the same", async () => {
  const { container: host } = await mount({ kind: "session", id: "jx7b0m0" });
  expect(host.querySelector(".dpp-focus")!.textContent).toContain("jx7b0m0");
});

test("a task keeps its plain word", async () => {
  const { container: host } = await mount({ kind: "task", id: "ct-98653" });
  expect(host.querySelector(".dpp-focus b")!.textContent).toBe("ct-98653");
});
