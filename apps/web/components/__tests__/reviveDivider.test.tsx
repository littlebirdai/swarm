import { describe, expect, test } from "bun:test";
import { mountWeb } from "../../test-helpers/mountWeb";
import {
  MID_WORK_REVIVE_MESSAGE,
  MOVE_INTERRUPT_MESSAGE,
} from "@codecast/messages/machineMessages";

import { ReviveDivider } from "../conversation/blocks/systemBlocks";

describe("revive divider", () => {
  test("a one-line rule with the note collapsed", async () => {
    const { container } = await mountWeb(
      <ReviveDivider
        content={MID_WORK_REVIVE_MESSAGE}
        timestamp={1_790_000_000_000}
      />,
    );
    expect(container.innerHTML).toContain(
      'data-switch-divider="mid-work-revive"',
    );
    expect(container.innerHTML).toContain(
      "restarted after the agent process exited",
    );
    expect(container.innerHTML).not.toContain("Pick up where you left off");
    expect(container.innerHTML).not.toContain("usage limit");
  });

  test("a move that cut a turn names the move, not account recovery", async () => {
    const { container } = await mountWeb(
      <ReviveDivider
        content={MOVE_INTERRUPT_MESSAGE}
        timestamp={1_790_000_000_000}
        cause="move"
      />,
    );
    expect(container.innerHTML).toContain(
      'data-switch-divider="move-interrupt"',
    );
    expect(container.innerHTML).toContain("machine move");
    expect(container.innerHTML).not.toContain("Pick up where you left off");
    expect(container.innerHTML).not.toContain("account recovery");
  });
});
