import { afterEach, expect, test } from "bun:test";
import { setKnownValuesForTest } from "../known-value-redaction.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { capturePane, redactFrame } from "./paneStream.js";
import { tmuxRun } from "../tmux.js";
import { captureTeamPane, streamTeamPane } from "./team-pane-stream.js";

afterEach(() => setKnownValuesForTest(null));

test("team publishing redacts each screen before it crosses the transport", async () => {
  const secret = "test-registered-secret-value";
  setKnownValuesForTest([{ value: secret, name: "test", vault: true }]);
  let now = 0;
  const captured: { pane_instance?: string; frame?: string }[] = [];
  const screens = [`First ${secret}`, `Second ${secret}`];
  await streamTeamPane("cc-watch", {
    capture: () => ({ identity: "%1|42", text: screens.shift()! }),
    push: async (frame) => {
      captured.push(frame);
      return captured.length === 2;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  expect(captured.map((frame) => frame.frame)).toEqual([
    expect.stringContaining("First "),
    expect.stringContaining("Second "),
  ]);
  expect(JSON.stringify(captured)).not.toContain(secret);
});

test("a replacement in the same tmux target sends only the end signal", async () => {
  let now = 0;
  const captured: { pane_instance?: string; frame?: string }[] = [];
  await streamTeamPane("cc-watch", {
    capture: () =>
      now === 0
        ? { identity: "first", text: "Old pane" }
        : { identity: "replacement", text: "New pane" },
    push: async (frame) => {
      captured.push(frame);
      return captured.length >= 2;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  expect(captured).toEqual([{ pane_instance: "first", frame: "Old pane" }, {}]);
});

test("a re-dispatched stream checks the original physical pane before sending a screen", async () => {
  const captured: { pane_instance?: string; frame?: string }[] = [];
  await streamTeamPane(
    "cc-watch",
    {
      capture: () => ({ identity: "replacement", text: "New pane" }),
      push: async (frame) => {
        captured.push(frame);
        return true;
      },
      now: () => 0,
      sleep: async () => {},
    },
    "original",
  );
  expect(captured).toEqual([{}]);
});

test("capture binds the physical pane and refuses a partial tmux session name", async () => {
  const name = "watch-exact";
  const second = "watch-other";
  expect(tmuxRun(["new-session", "-d", "-s", name, "sleep", "60"]).status).toBe(
    0,
  );
  try {
    expect(
      tmuxRun(["new-session", "-d", "-s", second, "sleep", "60"]).status,
    ).toBe(0);
    expect(
      tmuxRun([
        "display-message",
        "-p",
        "-t",
        "watch-exac:0.0",
        "#{session_name}",
      ]).stdout.trim(),
    ).toBe(name);
    expect(await captureTeamPane(second)).not.toBeNull();
    const first = await captureTeamPane(name);
    expect(first?.identity).toStartWith(`${name}|`);
    expect(await captureTeamPane("watch-exac:0.0")).toBeNull();
    expect(
      tmuxRun(["respawn-pane", "-k", "-t", `${name}:0.0`, "sleep", "60"])
        .status,
    ).toBe(0);
    const replacement = await captureTeamPane(name);
    expect(replacement?.identity).toStartWith(`${name}|`);
    expect(replacement?.identity).not.toBe(first?.identity);
  } finally {
    tmuxRun(["kill-session", "-t", name]);
    tmuxRun(["kill-session", "-t", second]);
  }
});

test("isolated tmux redacts a value that wraps after a space at the pane width", async () => {
  const name = "watch-space";
  const first = "ABCDEFGHIJKLMNOPQRS";
  const second = "synthetic-tail";
  setKnownValuesForTest([
    { name: "fixture", value: first + " " + second, vault: true },
  ]);
  const create = tmuxRun([
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "20",
    "-y",
    "8",
    `printf '%s\\n' '${first} ${second}'; sleep 60`,
  ]);
  expect(create.status).toBe(0);
  try {
    await pollUntil(
      async () => (await captureTeamPane(name))?.text.includes(second) ?? false,
      "synthetic value on the isolated pane",
    );
    const team = (await captureTeamPane(name))!;
    const owner = capturePane(name)!;
    const legacy = tmuxRun(["capture-pane", "-p", "-e", "-t", `${name}:0.0`]);
    expect(legacy.status).toBe(0);
    expect(owner.frame).toBe(legacy.stdout.replace(/\n$/, ""));
    const screen = await publishedScreen(team.text);
    expect(screen).not.toContain(first);
    expect(screen).not.toContain(second);
    expect(screen).toContain("[redacted:");
  } finally {
    tmuxRun(["kill-session", "-t", name]);
  }
});

test("team frames stop before capture when the known-value matcher is unavailable", async () => {
  let published = 0;
  await streamTeamPane(
    "fixture",
    {
      redactionReady: () => published === 0,
      capture: () => ({
        identity: "original",

        text: `sample ${published}`,
      }),
      push: async () => ++published > 1,
      now: () => 1,
      sleep: async () => {},
    },
    "original",
  );
  expect(published).toBe(1);
});

test("isolated tmux redacts a value wrapped before a two-cell character", async () => {
  const name = "watch-wide";
  const first = "ABCDEFGHIJKLMNOPQRS";
  const second = "界synthetic-tail";
  setKnownValuesForTest([
    { name: "fixture", value: first + second, vault: true },
  ]);
  expect(
    tmuxRun([
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "20",
      "-y",
      "8",
      `printf '%s\\n' '${first}${second}'; sleep 60`,
    ]).status,
  ).toBe(0);
  try {
    await pollUntil(
      async () => (await captureTeamPane(name))?.text.includes(second) ?? false,
      "wide fixture on the isolated pane",
    );
    const pushes: string[] = [];
    await streamTeamPane(name, {
      capture: captureTeamPane,
      now: Date.now,
      sleep: async () => {},
      push: async ({ frame }) => {
        if (frame) pushes.push(frame);
        return true;
      },
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("[redacted:");
    expect(pushes[0]).not.toContain(first);
    expect(pushes[0]).not.toContain(second);
  } finally {
    tmuxRun(["kill-session", "-t", name]);
  }
});

async function publishedScreen(text: string): Promise<string> {
  let published: string | undefined;
  await streamTeamPane("fixture", {
    capture: () => ({ identity: "original", text }),
    now: () => 1,
    sleep: async () => {},
    push: async ({ frame }) => {
      published = frame;
      return true;
    },
  });
  expect(published).toBeDefined();
  return published!;
}

test.each(['"', "'"])(
  "a prose quote (%s) leaves the next password to the shared redactor",
  async (quote) => {
    const value = "fixture_opaque_value_" + "987654321";
    const prefix = `SyntaxError: unexpected token: ${quote}\n`;
    const frame = `${prefix}DB_PASSWORD=${quote}${value}${quote} public suffix`;
    expect(await publishedScreen(frame)).toBe(
      `${prefix}DB_PASSWORD=${quote}[redacted:secret-assignment]${quote} public suffix`,
    );
  },
);

test.each([
  ['token="a"&' + "secret_tail_xyz987654"],
  [
    JSON.stringify({
      kty: "RSA",
      d: "fixture-private-part",
      custom_secret: "fixture-vault-tail",
    }),
  ],
  ["APP_TOKEN=" + "fixture_known_value_987654321"],
])(
  "a known Vault value survives intact through the first redaction pass (%#)",
  async (value) => {
    setKnownValuesForTest([{ value, name: "fixture", vault: true }]);
    const screen = await publishedScreen(`before ${value} after`);
    expect(screen).toMatch(/^before \[redacted:[^\]]+\] after$/);
  },
);

const keyRows = ["G", "H", "I", "J"].map((ch) => ch.repeat(64));
const paddedTail = "KLMNOPQ=";

test.each([
  [
    "git log text",
    '    Use ACCESS_TOKEN to sign in\n    token: "how it works"\n    Keep commit summaries',
  ],
  ["fetch credentials", 'credentials: "include"'],
  ["token type", 'tokenType: "Bearer"'],
  ["prose quote", "unexpected token: 'foo'"],
  ["same-line assignment", 'APP_SECRET="sample text"'],
  ["key that only contains a secret word", 'TOKEN_TYPE="sample\npublic text"'],
  ["consecutive assignments", 'APP_SECRET="unclosed\nPUBLIC=""\npublic tail'],
  ["unclosed prose", 'APP_SECRET="unclosed\nError: unexpected token: "'],
  ["SHA-256 list", ["a", "b", "c", "d"].map((ch) => ch.repeat(64)).join("\n")],
  ["hex dump", ["A", "B", "C", "D"].map((ch) => ch.repeat(64)).join("\n")],
  [
    "public certificate",
    [
      "-----BEGIN CERTIFICATE-----",
      ...keyRows,
      paddedTail,
      "-----END CERTIFICATE-----",
    ].join("\n"),
  ],
  [
    "public JWK beside unrelated JSON",
    '{"kty":"RSA","n":"public"} {"d":"date","p":"page","k":"key"}',
  ],
  [
    "public JWK with an unrelated nested object",
    '{"kty":"RSA","n":"public","meta":{"d":"date","p":"page"}}',
  ],
])("keeps %s byte for byte", async (_name, input) => {
  expect(await publishedScreen(input!)).toBe(input!);
});

test("redacts a markerless base64 run and its short padded last row", async () => {
  const screen = await publishedScreen(
    ["before", ...keyRows, paddedTail, "after"].join("\n"),
  );
  expect(screen.split("\n")).toHaveLength(keyRows.length + 3);
  for (const row of [...keyRows, paddedTail]) expect(screen).not.toContain(row);
  expect(screen).toStartWith("before\n");
  expect(screen).toEndWith("\nafter");
});

test("redacts an encoded PGP private block", async () => {
  const encodedPgp = btoa(
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture\n-----END PGP PRIVATE KEY BLOCK-----",
  );
  expect(await publishedScreen(`before ${encodedPgp} after`)).toBe(
    "before [redacted:terminal-secret] after",
  );
});

test("a multiline replacement preserves the text after its closing delimiter", async () => {
  const screen = await publishedScreen(
    'APP_SECRET="fixture first\nfixture last" public suffix',
  );
  expect(screen).not.toContain("fixture");
  expect(screen).toEndWith(" public suffix");
});

test("a private key replacement preserves both ends of its marker rows", async () => {
  const screen = await publishedScreen(
    "public prefix -----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture\n-----END PGP PRIVATE KEY BLOCK----- public suffix",
  );
  expect(screen).not.toContain("fixture");
  expect(screen).toStartWith("public prefix ");
  expect(screen).toEndWith(" public suffix");
});

test("owner redaction preserves a value that only the team redactor masks", () => {
  const frame = 'client-key-data: "sample"';
  expect(redactFrame(frame, 80)).toBe(frame);
});
