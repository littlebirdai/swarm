import { expect, test } from "bun:test";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { CallSessionChips } from "../CallSessionChips";

const session = (
  i: number,
  over: Partial<{
    live: boolean;
    excerpts: { from_seq: number; to_seq: number; at: number }[];
  }> = {},
) => ({
  conversation_id: `conv${i}`,
  short_id: `conv${i}`,
  title: `Session ${i}`,
  agent_type: "claude_code",
  name: `Agent ${i}`,
  character_avatar: null,
  character_name: null,
  live: true,
  excerpts: [],
  ...over,
});

test("a call with many sessions shows three chips and a +N menu", async () => {
  const { container: c } = await mountWeb(
    <CallSessionChips
      callId="t1"
      sessions={[1, 2, 3, 4, 5, 6].map((i) => session(i))}
    />,
  );
  const chips = [...c.querySelectorAll("button")].map((b) => b.textContent);
  expect(chips.slice(0, 3)).toEqual(["Agent 1", "Agent 2", "Agent 3"]);
  expect(chips[3]).toBe("+3");
  expect(chips).toHaveLength(4);
});

test("a few sessions with no excerpts need no menu", async () => {
  const { container: c } = await mountWeb(
    <CallSessionChips callId="t1" sessions={[session(1), session(2)]} />,
  );
  expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "Agent 1",
    "Agent 2",
  ]);
});

test("an excerpt makes the menu reachable even when every session fits", async () => {
  const { container: c } = await mountWeb(
    <CallSessionChips
      callId="t1"
      sessions={[
        session(1, {
          live: false,
          excerpts: [{ from_seq: 2, to_seq: 6, at: 1 }],
        }),
      ]}
    />,
  );
  expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "Agent 1",
    "excerpts",
  ]);
});

test("a session the thread's head already shows is not a chip again, and the rest read as where the call was sent", async () => {
  const { container: c, rerender } = await mountWeb(
    <CallSessionChips
      callId="t1"
      sessions={[session(1), session(2)]}
      inThread={new Set([session(1).conversation_id])}
    />,
  );
  expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "Agent 2",
  ]);
  expect(c.textContent).toContain("sent to");
  await rerender(
    <CallSessionChips
      callId="t1"
      sessions={[session(1)]}
      inThread={new Set([session(1).conversation_id])}
    />,
  );
  expect(c.querySelectorAll("button")).toHaveLength(0);
});
