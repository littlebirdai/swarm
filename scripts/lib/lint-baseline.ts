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

  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
    const allowed = baseline[file] ?? {};
    const actual = current[file] ?? {};
    const remaining: Record<string, number> = Object.create(null);

    for (const rule of [...new Set([...Object.keys(allowed), ...Object.keys(actual)])].sort()) {
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
