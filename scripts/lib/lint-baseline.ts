export type LintCounts = Record<string, Record<string, number>>;

export type CountChange = {
  file: string;
  rule: string;
  before: number;
  after: number;
};

export type DiagnosticSpans = Map<
  string,
  { source: string; rules: Map<string, DiagnosticLines[]> }
>;

type FlowNode = FlowEdge[];
type FlowEdge = { to: FlowNode; capacity: number; reverse: FlowEdge };

function connect(from: FlowNode, to: FlowNode, capacity: number): FlowEdge {
  const reverse = { to: from, capacity: 0 } as FlowEdge;
  const edge = { to, capacity, reverse };
  reverse.reverse = edge;
  from.push(edge);
  to.push(reverse);
  return edge;
}

function fillTransfers(source: FlowNode, sink: FlowNode) {
  for (;;) {
    const incoming = new Map<FlowNode, FlowEdge>();
    const queue = [source];
    for (const node of queue) {
      if (incoming.has(sink)) break;
      for (const edge of node) {
        if (edge.capacity <= 0 || edge.to === source || incoming.has(edge.to))
          continue;
        incoming.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
    if (!incoming.has(sink)) return;

    let capacity = Infinity;
    for (let node = sink; node !== source;) {
      const edge = incoming.get(node)!;
      capacity = Math.min(capacity, edge.capacity);
      node = edge.reverse.to;
    }
    for (let node = sink; node !== source;) {
      const edge = incoming.get(node)!;
      edge.capacity -= capacity;
      edge.reverse.capacity += capacity;
      node = edge.reverse.to;
    }
  }
}

function countSpans(
  spans: DiagnosticLines[],
  subtract: DiagnosticLines[] = [],
) {
  const counts = new Map<string, { lines: DiagnosticLines; count: number }>();
  for (const [entries, delta] of [
    [spans, 1],
    [subtract, -1],
  ] as const) {
    for (const lines of entries) {
      const key = JSON.stringify([lines.text, lines.previous, lines.next]);
      const entry = counts.get(key) ?? { lines, count: 0 };
      entry.count += delta;
      counts.set(key, entry);
    }
  }
  return counts;
}

function countSourceOccurrences(source: string, text: string): number {
  const target = `\n${text}\n`;
  let count = 0;
  for (
    let offset = source.indexOf(target);
    offset !== -1;
    offset = source.indexOf(target, offset + 1)
  )
    count++;
  return count;
}

function spanKeys(rule: string, { text, previous, next }: DiagnosticLines) {
  return [
    ...(previous ? [JSON.stringify([rule, text, "previous", previous])] : []),
    ...(next ? [JSON.stringify([rule, text, "next", next])] : []),
  ];
}

export function matchLintTransfers(
  donations: CountChange[],
  requests: CountChange[],
  beforeSpans: DiagnosticSpans,
  afterSpans: DiagnosticSpans,
): CountChange[] {
  if (!donations.length || !requests.length) return requests;
  const source: FlowNode = [];
  const sink: FlowNode = [];
  const signatures = new Map<string, FlowNode>();
  const destinations = requests.map((request) => {
    const { file, rule, before, after } = request;
    const destination: FlowNode = [];
    for (const { lines, count } of countSpans(
      afterSpans.get(file)?.rules.get(rule) ?? [],
    ).values()) {
      const occurrence: FlowNode = [];
      connect(occurrence, destination, count);
      for (const signature of spanKeys(rule, lines)) {
        let node = signatures.get(signature);
        if (!node) signatures.set(signature, (node = []));
        connect(node, occurrence, count);
      }
    }
    return { request, edge: connect(destination, sink, after - before) };
  });

  for (const { file, rule, before, after } of donations) {
    const donor: FlowNode = [];
    connect(source, donor, before - after);
    const previous = beforeSpans.get(file);
    if (!previous) continue;
    const current = afterSpans.get(file);
    const dropped = countSpans(
      previous.rules.get(rule) ?? [],
      current?.rules.get(rule) ?? [],
    );
    const removedLines = new Map<string, FlowNode>();
    for (const { lines, count } of dropped.values()) {
      if (count <= 0) continue;
      const matches = spanKeys(rule, lines).flatMap((key) =>
        signatures.has(key) ? [signatures.get(key)!] : [],
      );
      if (!matches.length) continue;
      let line = removedLines.get(lines.text);
      if (!line) {
        line = [];
        removedLines.set(lines.text, line);
        const removed =
          countSourceOccurrences(previous.source, lines.text) -
          countSourceOccurrences(current?.source ?? "", lines.text);
        connect(donor, line, removed);
      }
      const occurrence: FlowNode = [];
      connect(line, occurrence, count);
      for (const signature of matches) connect(occurrence, signature, count);
    }
  }

  fillTransfers(source, sink);
  return destinations.map(({ request, edge }) => ({
    ...request,
    before: request.before + edge.reverse.capacity,
  }));
}

export function compareLintCounts(baseline: LintCounts, current: LintCounts) {
  const grew: CountChange[] = [];
  const shrank: CountChange[] = [];
  const pruned: LintCounts = Object.create(null);

  for (const file of [
    ...new Set([...Object.keys(baseline), ...Object.keys(current)]),
  ].sort()) {
    const allowed = baseline[file] ?? {};
    const actual = current[file] ?? {};
    const remaining: Record<string, number> = Object.create(null);

    for (const rule of [
      ...new Set([...Object.keys(allowed), ...Object.keys(actual)]),
    ].sort()) {
      const before = Object.hasOwn(allowed, rule) ? allowed[rule]! : 0;
      const after = Object.hasOwn(actual, rule) ? actual[rule]! : 0;
      if (after > before) grew.push({ file, rule, before, after });
      if (after < before) shrank.push({ file, rule, before, after });
      if (before > 0 && after > 0) remaining[rule] = Math.min(before, after);
    }

    if (Object.keys(remaining).length > 0) pruned[file] = remaining;
  }

  return { grew, shrank, pruned };
}

export function carryRenames(
  counts: LintCounts,
  renames: ReadonlyArray<readonly [string, string]>,
): LintCounts {
  const carried: LintCounts = Object.create(null);
  for (const [file, rules] of Object.entries(counts)) carried[file] = rules;
  for (const [from, to] of renames) {
    if (!Object.hasOwn(carried, from) || Object.hasOwn(carried, to)) continue;
    carried[to] = carried[from]!;
    delete carried[from];
  }
  return carried;
}

export function parseRenames(nameStatus: string): Array<[string, string]> {
  const fields = nameStatus.split("\0");
  const renames: Array<[string, string]> = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i++]!;
      const to = fields[i++]!;
      if (status.startsWith("R")) renames.push([from, to]);
    } else {
      i++;
    }
  }
  return renames;
}

export function staleFiles(
  counts: LintCounts,
  exists: (file: string) => boolean,
): string[] {
  return Object.keys(counts)
    .filter((file) => !exists(file))
    .sort();
}
import type { DiagnosticLines } from "./oxlint";
