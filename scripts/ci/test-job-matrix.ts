type Value = string | number | boolean;
type Entry = Record<string, Value>;
type Matrix = Record<string, Value[]>;

export function matrixEntries(matrix: Matrix = {}): Entry[] {
  let entries: Entry[] = [{}];
  for (const [key, values] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude" || !Array.isArray(values)) {
      throw new Error(`Unsupported CI matrix key ${key}`);
    }
    entries = entries.flatMap((entry) =>
      values.map((value) => ({ ...entry, [key]: value })),
    );
  }
  return entries;
}

const OUTPUT_PREFIX = String.raw`needs\.code_paths\.outputs\.`;
const OUTPUT = `${OUTPUT_PREFIX}(run_\\w+)`;
const VALUE = String.raw`(?:matrix\.\w+|${OUTPUT_PREFIX}run_\w+|'[^']*'|\d+|true|false)`;
const COMPARISON = new RegExp(`^(${VALUE})\\s*(==|!=)\\s*(${VALUE})$`);
const PREFIX = new RegExp(
  `^startsWith\\(\\s*(${VALUE})\\s*,\\s*(${VALUE})\\s*\\)$`,
);

function operand(token: string, entry: Entry, flags: Entry): Value {
  if (token.startsWith("matrix.")) return entry[token.slice(7)] ?? "";
  if (token.startsWith("needs.")) return flags[token.split(".").at(-1)!];
  if (token.startsWith("'")) return token.slice(1, -1);
  if (token === "true" || token === "false") return token === "true";
  return Number(token);
}

function equal(a: Value, b: Value): boolean {
  return typeof a === typeof b
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : Number(a) === Number(b);
}

function conditionMatches(
  condition: string | boolean,
  entry: Entry,
  flags: Entry,
): boolean {
  if (typeof condition === "boolean") return condition;
  const expression = condition.replace(/^\s*\$\{\{([\s\S]+)\}\}\s*$/, "$1");
  return expression
    .split(/&&(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((part) => {
      const term = part.trim();
      const negate = term.startsWith("!");
      const atom = (negate ? term.slice(1) : term).trim();
      const comparison = COMPARISON.exec(atom);
      const prefix = PREFIX.exec(atom);
      const value = (token: string) => operand(token, entry, flags);
      if (comparison) {
        const [, left, operator, right] = comparison;
        return (
          (equal(value(left), value(right)) === (operator === "==")) !== negate
        );
      }
      if (prefix) {
        return (
          String(value(prefix[1]))
            .toLowerCase()
            .startsWith(String(value(prefix[2])).toLowerCase()) !== negate
        );
      }
      if (atom === "cancelled()" || atom === "false") return negate;
      if (new RegExp(`^${VALUE}$`).test(atom))
        return Boolean(value(atom)) !== negate;
      throw new Error(`Unsupported test step condition: ${condition}`);
    })
    .every(Boolean);
}

export function selectedEntries(
  matrix: Matrix | undefined,
  conditions: Array<string | boolean | undefined>,
): Entry[] {
  const active = conditions.filter((condition) => condition !== undefined);
  const outputs = new Set(
    active.flatMap((condition) =>
      [...String(condition).matchAll(new RegExp(OUTPUT, "g"))].map(
        (match) => match[1],
      ),
    ),
  );
  const flags = matrixEntries(
    Object.fromEntries([...outputs].map((key) => [key, ["true", "false"]])),
  );
  return matrixEntries(matrix).filter((entry) =>
    flags.some((values) =>
      active
        .map((condition) => conditionMatches(condition, entry, values))
        .every(Boolean),
    ),
  );
}
