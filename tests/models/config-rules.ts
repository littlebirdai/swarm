const sections = new Set(
  "CONSTANT CONSTANTS CONSTRAINT CONSTRAINTS ACTION_CONSTRAINT ACTION_CONSTRAINTS INVARIANT INVARIANTS INIT NEXT VIEW SYMMETRY SPECIFICATION PROPERTY PROPERTIES TYPE TYPE_CONSTRAINT CHECK_DEADLOCK".split(
    " ",
  ),
);

type RuleSection = {
  kind: "invariants" | "properties";
  names: string[];
  start: number;
  end: number;
};

export function parseRuleSections(config: string): RuleSection[] {
  const tokens = /\\\*[^\r\n]*|\(\*|"(?:\\.|[^"\\])*"|\w+|\S/g;
  const delimiters = /\(\*|\*\)/g;
  const rules: RuleSection[] = [];
  let section: RuleSection | undefined;

  for (let match = tokens.exec(config); match; match = tokens.exec(config)) {
    const [token] = match;
    if (token.startsWith("\\*")) continue;
    if (token === "(*") {
      delimiters.lastIndex = tokens.lastIndex;
      let depth = 1;
      while (depth > 0) {
        const delimiter = delimiters.exec(config);
        if (!delimiter) throw new Error("Unclosed TLC config comment.");
        depth += delimiter[0] === "(*" ? 1 : -1;
      }
      tokens.lastIndex = delimiters.lastIndex;
      continue;
    }
    if (sections.has(token)) {
      section = undefined;
      if (/^(INVARIANTS?|PROPERT(?:Y|IES))$/.test(token)) {
        section = {
          kind: token.startsWith("INVARIANT") ? "invariants" : "properties",
          names: [],
          start: match.index,
          end: tokens.lastIndex,
        };
        rules.push(section);
      }
    } else if (section) {
      if (!/^\w+$/.test(token))
        throw new Error(`Invalid TLC rule name: ${token}`);
      section.names.push(token);
      section.end = tokens.lastIndex;
    }
  }
  return rules;
}
