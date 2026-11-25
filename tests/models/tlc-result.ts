type TlcResult =
  | { outcome: "holds"; distinctStates: number }
  | {
      outcome: "violated";
      kind: "invariant";
      rule: string;
      distinctStates?: number;
    }
  | {
      outcome: "violated";
      kind: "property";
      rule: string;
      distinctStates: number;
    };

export function parseTlcResult(
  exitCode: number,
  output: string,
  properties: readonly string[],
): TlcResult {
  const stats = output.match(
    /^[\d,]+ states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue\.$/m,
  );
  const finished = /^Finished in /m.test(output);
  const holds = /^Model checking completed\. No error has been found\.$/m.test(
    output,
  );
  const invariant = output.match(
    /^Error: Invariant (\w+) (is violated\.|is violated by the initial state:)$/m,
  );
  const temporal = /^Error: Temporal properties were violated\.$/m.test(output);
  const temporalFinished = /^Finished checking temporal properties\b/m.test(
    output,
  );
  const distinctStates = stats
    ? Number(stats[1].replaceAll(",", ""))
    : undefined;
  const queueEmpty = stats && Number(stats[2].replaceAll(",", "")) === 0;

  if (finished) {
    if (
      exitCode === 0 &&
      holds &&
      distinctStates !== undefined &&
      queueEmpty &&
      !invariant &&
      !temporal &&
      (properties.length === 0 || temporalFinished)
    ) {
      return { outcome: "holds", distinctStates };
    }
    if (exitCode === 12 && invariant && !holds && !temporal) {
      const initial = invariant[2] === "is violated by the initial state:";
      if (initial || distinctStates !== undefined) {
        return {
          outcome: "violated",
          kind: "invariant",
          rule: invariant[1],
          distinctStates,
        };
      }
    }
    if (
      exitCode === 13 &&
      temporal &&
      !holds &&
      !invariant &&
      properties.length === 1 &&
      distinctStates !== undefined &&
      queueEmpty
    ) {
      return {
        outcome: "violated",
        kind: "property",
        rule: properties[0],
        distinctStates,
      };
    }
  }
  throw new Error(`Unexpected TLC result (exit ${exitCode}).\n${output}`);
}
