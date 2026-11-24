import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8");
const containerSource = read("../ConversationView.tsx");
const cardSource = read("../conversation/blocks/systemBlocks.tsx");

function block(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test("the card gets the agent variant and the sender's session when it resolves", () => {
  const renderCase = block(
    containerSource,
    'case "session_message":',
    'case "huddle_summary":',
  );
  expect(renderCase).toContain(
    `variant={kind.variant === "agent" ? "agent" : "session"}`,
  );
  expect(renderCase).toContain("agentNameToChildMap?.[kind.from]");
});

test("an agent name is a badge, never an EntityIdPill", () => {
  const card = block(
    cardSource,
    "function SessionMessageBlock(",
    "// ── Team chat",
  );
  // A subagent name and a teammate id both fail to resolve as session short ids,
  // so both take the badge branch; only a real session id gets the pill.
  expect(card).toContain("const namedSender = isTeammate || isAgentReport;");
  expect(card).toMatch(/\{namedSender \? \(/);
});
