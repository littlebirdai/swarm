import { expect, test } from "bun:test";
import { setKnownValuesForTest } from "../known-value-redaction.js";
import { redactTeamScreen } from "./team-pane-redaction.js";

const begin = "-----BEGIN PRIVATE KEY-----";
const end = "-----END PRIVATE KEY-----";
const keyRows = ["synthetic key row one", "synthetic key row two"];

test.each([
  ["entire", ["above", begin, ...keyRows, end, "below"], ["above", "below"]],
  ["top clipped", [...keyRows, end, "below"], ["below"]],
  ["bottom clipped", ["above", begin, ...keyRows], ["above"]],
] as const)(
  "redacts a PEM key with %s screen content and preserves neighboring text",
  (_name, rows, neighbors) => {
    const screen = redactTeamScreen(rows.join("\n"));
    if (_name !== "entire")
      expect(screen.split("\n")).toHaveLength(rows.length);
    for (const key of keyRows) expect(screen).not.toContain(key);
    for (const neighbor of neighbors) expect(screen).toContain(neighbor);
  },
);

const opaque = ["synthetic", "value", "for", "tests"].join("-");
const encoded = btoa([begin, opaque, end].join("\n"));
test.each([
  [
    "PGP private block",
    [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      opaque,
      "-----END PGP PRIVATE KEY BLOCK-----",
    ],
    opaque,
  ],
  ...["d", "p", "q", "dp", "dq", "qi", "k", "oth"].map(
    (field) =>
      [
        `JWK private field ${field}`,
        [
          "{",
          '"kty": "RSA",',
          JSON.stringify(field) +
            ": " +
            (field === "oth"
              ? JSON.stringify([{ r: opaque }])
              : JSON.stringify(opaque)),
          "}",
        ],
        opaque,
      ] as const,
  ),
  ["client-key-data", [`  client-key-data: "${opaque}"`], opaque],
  [
    "client-key-data block",
    [
      "client-key-data: |",
      "  " + encoded.slice(0, 12),
      "  " + encoded.slice(12),
    ],
    encoded.slice(12),
  ],
  ["encoded PEM", [encoded], encoded],
  [
    "bare multiline assignment",
    ['PASSWORD="example', opaque, 'last line"'],
    opaque,
  ],
  [
    "quoted multiline assignment",
    ['APP_SECRET="example', opaque, 'last line"'],
    opaque,
  ],
] as const)(
  "terminal hints redact %s, retain row count and preserve public neighbors",
  (_kind, rows, secret) => {
    const input = ["public before", ...rows, "public after"].join("\n");
    const screen = redactTeamScreen(input);
    expect(screen).not.toContain(secret);
    expect(screen).toContain("public before");
    expect(screen).toContain("public after");
    expect(screen.split("\n")).toHaveLength(input.split("\n").length);
  },
);

test("8-bit CSI inside a known value does not hide it from redaction", () => {
  setKnownValuesForTest([{ value: opaque, name: "fixture", vault: true }]);
  try {
    const screen = redactTeamScreen(
      opaque.slice(0, 10) + "\x9b31m" + opaque.slice(10),
    );
    expect(screen).toContain("[redacted:");
    expect(screen).not.toContain(opaque.slice(10));
  } finally {
    setKnownValuesForTest(null);
  }
});
