import { expect, test } from "bun:test";
import { summarizeMemory } from "./memoryStats.js";

test("memory summary takes the daemon peak and counts each live process once by provider", () => {
  const claude = (identity: string, rssBytes: number) => ({ identity, rssBytes, provider: "claude" });
  const codex = { identity: "12:started", rssBytes: 55, provider: "codex" };
  expect(summarizeMemory([
    { daemonRssBytes: 100, agents: [claude("10:start", 10), codex] },
    { daemonRssBytes: 140, agents: [claude("10:start", 90), claude("11:start", 30), codex] },
    { daemonRssBytes: 110, agents: [claude("10:reused", 20), claude("13:start", 50)] },
  ])).toEqual({
    daemonRss: { startBytes: 100, peakBytes: 140, endBytes: 110 },
    agentRss: [
      { provider: "claude", count: 4, medianBytes: 40, p90Bytes: 90, maxBytes: 90 },
      { provider: "codex", count: 1, medianBytes: 55, p90Bytes: 55, maxBytes: 55 },
    ],
  });
});

test("memory summary distinguishes a missing endpoint sample from an empty fleet", () => {
  const missing = { daemonRssBytes: null, agents: null };
  expect(summarizeMemory([missing, { daemonRssBytes: 18, agents: null }, missing])).toEqual({
    daemonRss: { startBytes: null, peakBytes: 18, endBytes: null },
    agentRss: null,
  });
  expect(summarizeMemory([{ daemonRssBytes: 18, agents: [] }]).agentRss).toEqual([]);
});

test("p90 describes the provider distribution below its maximum", () => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ identity: String(i), provider: "grok", rssBytes: (10 - i) * 1024 }));
  expect(summarizeMemory([{ daemonRssBytes: null, agents }]).agentRss).toEqual([
    { provider: "grok", count: 10, medianBytes: 5632, p90Bytes: 9216, maxBytes: 10240 },
  ]);
});
