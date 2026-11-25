import { expect, test } from "bun:test";
import {
  applyRelayGrantClaims,
  parseRelayClientFrame,
  parseRelayGrantClaims,
  type RelayGrantClaims,
  type RelayHubGrant,
} from "../src";

const user = { kind: "user", id: "principal-1" } as const;
const machine = { kind: "machine", id: user.id } as const;
const session = { kind: "session", id: "session-1" } as const;
const now = 1700000000000;
const deadline = now + 5000;
const claims = {
  v: 1,
  audience: "cell-1",
  subject: user,
  expires_at_ms: deadline,
  grants: [
    {
      ...session,
      publish: [
        "presence",
        "draft_cursor",
        "reading_cursor",
        "baton_heartbeat",
      ],
    },
    { ...machine, publish: [] },
  ],
} satisfies RelayGrantClaims;

test("grant claims accept publish rights tied to their subject and hub", () => {
  const machineClaims = {
    ...claims,
    subject: machine,
    grants: [
      { ...session, publish: ["session_liveness"] },
      { ...machine, publish: ["machine_liveness"] },
      { ...machine, id: "other-machine", publish: [] },
    ],
  } satisfies RelayGrantClaims;
  for (const value of [claims, machineClaims]) {
    expect(parseRelayGrantClaims(JSON.stringify(value))).toEqual({
      ok: true,
      value,
    });
  }
});

test("grant claims reject publish rights outside the subject's role and scope", () => {
  const forbidden = [
    { ...claims, grants: [{ ...session, publish: ["session_liveness"] }] },
    { ...claims, grants: [{ ...machine, publish: ["machine_liveness"] }] },
    {
      ...claims,
      subject: machine,
      grants: [{ ...machine, id: "other", publish: ["machine_liveness"] }],
    },
    {
      ...claims,
      subject: machine,
      grants: [{ ...session, publish: ["draft_cursor"] }],
    },
    {
      ...claims,
      subject: machine,
      grants: [{ ...machine, publish: ["presence"] }],
    },
  ];
  for (const value of forbidden) {
    expect(parseRelayGrantClaims(JSON.stringify(value))).toEqual({
      ok: false,
      error: { code: "invalid_field", path: "$.grants[0].publish[0]" },
    });
  }
});

test("grant claims reject duplicate hubs and duplicate publish rights", () => {
  for (const [grants, path] of [
    [
      [
        { ...session, publish: [] },
        { ...session, publish: ["presence"] },
      ],
      "$.grants[1]",
    ],
    [
      [{ ...session, publish: ["presence", "presence"] }],
      "$.grants[0].publish[1]",
    ],
  ] as const) {
    expect(
      parseRelayGrantClaims(JSON.stringify({ ...claims, grants })),
    ).toEqual({
      ok: false,
      error: { code: "invalid_field", path },
    });
  }
  const sameId = {
    ...claims,
    grants: [
      { ...session, publish: [] },
      { ...machine, id: session.id, publish: [] },
    ],
  };
  expect(parseRelayGrantClaims(JSON.stringify(sameId)).ok).toBe(true);
});

test("grant claims fail closed on unsupported versions, fields, and publish rights", () => {
  const invalid = [
    [{ ...claims, v: undefined }, "$.v", "invalid_field"],
    [{ ...claims, v: 2 }, "$.v", "invalid_field"],
    [{ ...claims, audience: null }, "$.audience", "invalid_field"],
    [{ ...claims, expires_at_ms: 0 }, "$.expires_at_ms", "invalid_field"],
    [{ ...claims, grants: [] }, "$.grants", "invalid_field"],
    [
      {
        ...claims,
        grants: [
          claims.grants[0],
          { ...session, id: "future", publish: ["terminal"] },
        ],
      },
      "$.grants[1].publish[0]",
      "invalid_field",
    ],
    [
      { ...claims, grants: [{ ...session, publish: [], team_id: "team-1" }] },
      "$.grants[0].team_id",
      "unknown_field",
    ],
  ] as const;
  for (const [payload, path, code] of invalid) {
    expect(parseRelayGrantClaims(JSON.stringify(payload))).toEqual({
      ok: false,
      error: { code, path },
    });
  }
});

test("a 16-hub grant fits the token limit and the parser refuses a 17th hub", () => {
  const grants = Array.from({ length: 17 }, (_, index) => ({
    ...claims.grants[0],
    id: String(index).padStart(128, "s"),
  }));
  const worstClaims = {
    ...claims,
    audience: "a".repeat(128),
    subject: { ...user, id: "u".repeat(128) },
    expires_at_ms: Number.MAX_SAFE_INTEGER,
    grants: grants.slice(0, 16),
  };
  const payload = JSON.stringify(worstClaims);
  const encoded = btoa(payload)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const token = `${"h".repeat(256)}.${encoded}.${"s".repeat(86)}`;
  expect(
    parseRelayClientFrame(
      JSON.stringify({ type: "grant_update", v: 1, request_id: "r", token }),
    ).ok,
  ).toBe(true);
  expect(parseRelayGrantClaims(payload).ok).toBe(true);
  expect(
    parseRelayGrantClaims(JSON.stringify({ ...worstClaims, grants })),
  ).toEqual({
    ok: false,
    error: { code: "invalid_field", path: "$.grants" },
  });
});

test("grant updates replace the named hub, retain other live hubs, and prune expired hubs", () => {
  const replacing = {
    ...session,
    publish: [],
  } satisfies RelayGrantClaims["grants"][number];
  const kept = {
    ...machine,
    publish: [],
    expires_at_ms: now + 2000,
  } satisfies RelayHubGrant;
  const current = [
    { ...session, publish: ["presence"], expires_at_ms: now + 1000 },
    kept,
    { ...session, id: "expired", publish: [], expires_at_ms: now },
  ] satisfies RelayHubGrant[];
  const added = {
    ...session,
    id: "new",
    publish: ["reading_cursor"],
  } satisfies RelayGrantClaims["grants"][number];
  const result = applyRelayGrantClaims(
    user,
    current,
    { ...claims, grants: [replacing, added] },
    now,
  );
  expect(result).toEqual({
    status: "applied",
    grants: [
      { ...replacing, expires_at_ms: deadline },
      kept,
      { ...added, expires_at_ms: deadline },
    ],
  });
});

test("grant updates reject a different subject or an expired token", () => {
  expect(applyRelayGrantClaims(machine, [], claims, now)).toEqual({
    status: "refused",
    code: "subject_mismatch",
  });
  expect(
    applyRelayGrantClaims({ ...user, id: "other-user" }, [], claims, now),
  ).toEqual({ status: "refused", code: "subject_mismatch" });
  expect(applyRelayGrantClaims(user, [], claims, deadline)).toEqual({
    status: "refused",
    code: "expired",
  });
});

test("grant updates permit 256 live hubs and refuse an overflow atomically", () => {
  const updates = Array.from({ length: 16 }, (_, batch) => ({
    ...claims,
    grants: Array.from({ length: 16 }, (_, index) => ({
      ...session,
      id: `session-${batch * 16 + index}`,
      publish: [],
    })),
  }));
  let current: RelayHubGrant[] = [];
  for (const update of updates) {
    const result = applyRelayGrantClaims(user, current, update, now);
    expect(result.status).toBe("applied");
    if (result.status === "applied") current = result.grants;
  }
  expect(current).toHaveLength(256);
  const replacement = {
    ...session,
    publish: ["presence"],
  } satisfies RelayGrantClaims["grants"][number];
  expect(
    applyRelayGrantClaims(
      user,
      current,
      { ...claims, grants: [replacement] },
      now,
    ).status,
  ).toBe("applied");
  expect(
    applyRelayGrantClaims(
      user,
      current,
      {
        ...claims,
        grants: [replacement, { ...session, id: "overflow", publish: [] }],
      },
      now,
    ),
  ).toEqual({
    status: "refused",
    code: "hub_limit",
  });
  expect(current.find(({ id }) => id === replacement.id)?.publish).toEqual([]);
  expect(current).toHaveLength(256);
});
