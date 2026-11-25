import { redactKnownValues } from "../known-value-redaction.js";
import { redactSecrets } from "../redact.js";

const ESCAPES =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])|\x9b[0-?]*[ -/]*[@-~]/g;
const PRIVATE_KEY = String.raw`(?:[A-Z0-9 ]{0,40}PRIVATE KEY|PGP PRIVATE KEY BLOCK)`;
const KEY_BLOCK = new RegExp(
  String.raw`-----BEGIN ${PRIVATE_KEY}-----[\s\S]*?(?:-----END ${PRIVATE_KEY}-----|$)|^(?:(?!-----BEGIN )[\s\S])*?-----END ${PRIVATE_KEY}-----`,
  "g",
);
const ENCODED_KEY = new RegExp(`^-----BEGIN ${PRIVATE_KEY}-----`);
const KEY_ROWS =
  /-----BEGIN CERTIFICATE-----[\s\S]*?(?:-----END CERTIFICATE-----|(?![\s\S]))|(?:^[ \t]*(?:[A-Za-z0-9+/]{64}|[A-Za-z0-9+/]{76})[ \t]*(?:\n|$)){4,}(?:^[ \t]*[A-Za-z0-9+/]{2,74}={1,2}[ \t]*(?:\n|$))?/gm;
const MULTILINE_ASSIGNMENT =
  /^([ \t]*(?:export[ \t]+)?(?:[A-Z_][A-Z0-9_]{0,63})?(?:SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIALS?|ACCESS_KEY|API_KEY|PRIVATE_KEY)[ \t]*[:=][ \t]*)(?<quote>["'])(?:(?!\k<quote>)[^\\\n]|\\[^\n])*(?:\n(?![ \t]*(?:export[ \t]+)?[\w.-]+[ \t]*[:=])(?:(?!\k<quote>)[^\\\n]|\\[^\n])*)+\k<quote>(?!\w)/gim;

function mask(value: string): string {
  return (
    "[redacted:terminal-secret]" + "\n".repeat(value.split("\n").length - 1)
  );
}

function redactJwk(text: string): string {
  if (!text.includes('"kty"')) return text;
  type Range = [start: number, end: number];
  type Context =
    | { ends: "}"; jwk: boolean; fields: Range[] }
    | { ends: "]"; privateAt?: number };
  const stack: Context[] = [];
  const ranges: Range[] = [];
  const tokens = [
    ...text.matchAll(/"(?:[^"\\\r\n]|\\[^\r\n])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g),
  ];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const parent = stack.at(-1);
    const previous = tokens[i - 1]?.[0];
    if (token[0] === "{") {
      stack.push({ ends: "}", jwk: false, fields: [] });
    } else if (token[0] === "[") {
      const privateAt =
        parent?.ends === "}" &&
        previous === ":" &&
        tokens[i - 2]?.[0] === '"oth"'
          ? token.index
          : undefined;
      stack.push({ ends: "]", privateAt });
    } else if (token[0] === parent?.ends) {
      stack.pop();
      if (parent.ends === "}" && parent.jwk) ranges.push(...parent.fields);
      if (parent.ends === "]" && parent.privateAt !== undefined) {
        const object = stack.at(-1);
        if (object?.ends === "}")
          object.fields.push([parent.privateAt, token.index + 1]);
      }
    } else if (
      parent?.ends === "}" &&
      (previous === "{" || previous === ",") &&
      tokens[i + 1]?.[0] === ":"
    ) {
      const value = tokens[i + 2];
      if (!value) continue;
      if (token[0] === '"kty"' && /^"(?:RSA|EC|OKP|oct)"$/.test(value[0]))
        parent.jwk = true;
      if (/^"(?:d|p|q|dp|dq|qi|k)"$/.test(token[0]) && value[0].startsWith('"'))
        parent.fields.push([value.index, value.index + value[0].length]);
    }
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges.sort(([a], [b]) => a - b)) {
    if (start < cursor) continue;
    out += text.slice(cursor, start) + mask(text.slice(start, end));
    cursor = end;
  }
  return out + text.slice(cursor);
}

export function redactTeamScreen(screen: string): string {
  const shared = redactSecrets(redactKnownValues(screen.replace(ESCAPES, "")));
  return redactJwk(shared)
    .replace(KEY_BLOCK, mask)
    .replace(KEY_ROWS, (value) =>
      value.startsWith("-----BEGIN CERTIFICATE-----") ||
      !/^[ \t]*[A-Za-z0-9+/]*[G-Zg-z+/][A-Za-z0-9+/]*[ \t]*$/m.test(value)
        ? value
        : mask(value),
    )
    .replace(
      /(?<![\w-])(client-key-data[ \t]*:[ \t]*)([|>][-+]?[ \t]*\n(?:[ \t]+[A-Za-z0-9+/=]+[ \t]*(?:\n|$))+|"[^"\n]*"|'[^'\n]*'|[^ \t\n]+)/gi,
      (_match, label, value) => label + mask(value),
    )
    .replace(
      MULTILINE_ASSIGNMENT,
      (match, label) => label + mask(match.slice(label.length)),
    )
    .replace(/(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/=]*/g, (value) =>
      ENCODED_KEY.test(Buffer.from(value.slice(0, 120), "base64").toString())
        ? mask(value)
        : value,
    );
}
