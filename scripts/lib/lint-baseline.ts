export type LintCounts = Record<string, Record<string, number>>;

type CountChange = {
  file: string;
  rule: string;
  before: number;
  after: number;
};

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
