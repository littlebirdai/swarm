import { percentile } from "./stats.js";

interface AgentMemorySample {
  identity: string;
  provider: string;
  rssBytes: number;
}

export interface MemorySample {
  daemonRssBytes: number | null;
  agents: AgentMemorySample[] | null;
}

export function summarizeMemory(samples: readonly MemorySample[]) {
  let peakBytes: number | null = null;
  let inventorySamples = 0;
  const processes = new Map<string, AgentMemorySample>();
  for (const sample of samples) {
    if (sample.daemonRssBytes !== null) peakBytes = Math.max(peakBytes ?? 0, sample.daemonRssBytes);
    if (sample.agents === null) continue;
    inventorySamples++;
    for (const agent of sample.agents) {
      const previous = processes.get(agent.identity);
      processes.set(agent.identity, {
        ...agent,
        provider: agent.provider === "unknown" ? previous?.provider ?? agent.provider : agent.provider,
        rssBytes: Math.max(previous?.rssBytes ?? 0, agent.rssBytes),
      });
    }
  }
  const byProvider = new Map<string, number[]>();
  for (const { provider, rssBytes } of processes.values()) {
    const group = byProvider.get(provider) ?? [];
    group.push(rssBytes);
    byProvider.set(provider, group);
  }
  return {
    daemonRss: {
      startBytes: samples[0]?.daemonRssBytes ?? null,
      peakBytes,
      endBytes: samples.at(-1)?.daemonRssBytes ?? null,
    },
    agentRss: inventorySamples === 0 ? null : [...byProvider].sort(([a], [b]) => a.localeCompare(b)).map(([provider, values]) => {
      values.sort((a, b) => a - b);
      const count = values.length;
      const middle = Math.floor(count / 2);
      const medianBytes = count % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
      return { provider, count, medianBytes, p90Bytes: percentile(values, 0.9)!, maxBytes: values[count - 1] };
    }),
  };
}
