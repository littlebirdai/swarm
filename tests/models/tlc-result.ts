type TlcResult =
  | { outcome: "holds"; distinctStates: number }
  | {
      outcome: "violated";
      kind: "invariant" | "property";
      rule: string;
      distinctStates: number;
    };

export function parseTlcResult(
  exitCode: number,
  output: string,
  config: string,
): TlcResult {
  const stats = output.match(
    /^[\d,]+ states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue\.$/m,
  );
  const finished = /^Finished in /m.test(output);
  const holds = /^Model checking completed\. No error has been found\.$/m.test(
    output,
  );
  const invariant = output.match(
    /^Error: Invariant (\w+) (?:is violated\.|is violated by the initial state:?)$/m,
  );
  const temporal = /^Error: Temporal properties were violated\.$/m.test(output);
  const properties = [...config.matchAll(/^PROPERTY (\w+)$/gm)];

  if (stats && finished) {
    const distinctStates = Number(stats[1].replaceAll(",", ""));
    const queueEmpty = Number(stats[2].replaceAll(",", "")) === 0;
    if (exitCode === 0 && holds && queueEmpty && !invariant && !temporal) {
      return { outcome: "holds", distinctStates };
    }
    if (exitCode === 12 && invariant && !holds && !temporal) {
      return {
        outcome: "violated",
        kind: "invariant",
        rule: invariant[1],
        distinctStates,
      };
    }
    if (
      exitCode === 13 &&
      temporal &&
      !holds &&
      !invariant &&
      properties.length === 1 &&
      queueEmpty
    ) {
      return {
        outcome: "violated",
        kind: "property",
        rule: properties[0][1],
        distinctStates,
      };
    }
  }
  throw new Error(`Unexpected TLC result (exit ${exitCode}).\n${output}`);
}
