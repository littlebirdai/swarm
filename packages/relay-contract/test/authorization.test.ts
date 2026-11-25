import { expect, test } from "bun:test";
import {
  applyRelayGrantClaims,
  parseRelayClientFrame,
  parseRelayGrantClaims,
  releaseRelayGrants,
  type RelayGrantClaims,
  type RelayGrantState,
  type RelayHubGrant,
} from "../src";

const user = { kind: "user", id: "principal-1" } as const;
const machine = { kind: "machine", id: user.id } as const;
const session = { kind: "session", id: "session-1" } as const;
const now = 1700000000000;
const deadline = now + 5000;
const initial = { issued_at_ms: now - 2000, grant_seq: 1 };
const issuance = { issued_at_ms: now - 1000, grant_seq: 2 };
const empty: RelayGrantState = { grants: [], high_water: null };
const claims = {
  v: 1,
  ...issuance,
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
    [{ v: 2, future_claim: {} }, "$.v", "unsupported_version"],
    [{ ...claims, v: 0 }, "$.v", "invalid_field"],
    [{ ...claims, issued_at_ms: undefined }, "$.issued_at_ms", "invalid_field"],
    [{ ...claims, grant_seq: 0 }, "$.grant_seq", "invalid_field"],
    [{ ...claims, issued_at_ms: deadline }, "$.expires_at_ms", "invalid_field"],
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
    issued_at_ms: Number.MAX_SAFE_INTEGER - 1,
    grant_seq: Number.MAX_SAFE_INTEGER,
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
    ...initial,
    publish: [],
    expires_at_ms: now + 2000,
  } satisfies RelayHubGrant;
  const current = [
    {
      ...session,
      ...initial,
      publish: ["presence"],
      expires_at_ms: now + 1000,
    },
    kept,
    { ...session, ...initial, id: "expired", publish: [], expires_at_ms: now },
  ] satisfies RelayHubGrant[];
  const added = {
    ...session,
    id: "new",
    publish: ["reading_cursor"],
  } satisfies RelayGrantClaims["grants"][number];
  const result = applyRelayGrantClaims(
    user,
    { grants: current, high_water: initial },
    { ...claims, grants: [replacing, added] },
    now,
  );
  expect(result).toEqual({
    status: "applied",
    state: {
      high_water: issuance,
      grants: [
        { ...replacing, ...issuance, expires_at_ms: deadline },
        kept,
        { ...added, ...issuance, expires_at_ms: deadline },
      ],
    },
  });
});

test("grant updates reject a different subject or an expired token", () => {
  expect(applyRelayGrantClaims(machine, empty, claims, now)).toEqual({
    status: "refused",
    code: "subject_mismatch",
  });
  expect(
    applyRelayGrantClaims({ ...user, id: "other-user" }, empty, claims, now),
  ).toEqual({ status: "refused", code: "subject_mismatch" });
  expect(applyRelayGrantClaims(user, empty, claims, deadline)).toEqual({
    status: "refused",
    code: "expired",
  });
});

test("grant updates permit 256 live hubs and refuse an overflow atomically", () => {
  const updates = Array.from({ length: 16 }, (_, batch) => ({
    ...claims,
    grant_seq: batch + 1,
    grants: Array.from({ length: 16 }, (_, index) => ({
      ...session,
      id: `session-${batch * 16 + index}`,
      publish: [],
    })),
  }));
  let current = empty;
  for (const update of updates) {
    const result = applyRelayGrantClaims(user, current, update, now);
    expect(result.status).toBe("applied");
    if (result.status === "applied") current = result.state;
  }
  expect(current.grants).toHaveLength(256);
  const replacement = {
    ...session,
    publish: ["presence"],
  } satisfies RelayGrantClaims["grants"][number];
  expect(
    applyRelayGrantClaims(
      user,
      current,
      { ...claims, grant_seq: 17, grants: [replacement] },
      now,
    ).status,
  ).toBe("applied");
  expect(
    applyRelayGrantClaims(
      user,
      current,
      {
        ...claims,
        grant_seq: 17,
        grants: [replacement, { ...session, id: "overflow", publish: [] }],
      },
      now,
    ),
  ).toEqual({
    status: "refused",
    code: "hub_limit",
  });
  expect(
    current.grants.find(({ id }) => id === replacement.id)?.publish,
  ).toEqual([]);
  expect(current.grants).toHaveLength(256);

  const released = releaseRelayGrants(current, [session]);
  const churned = applyRelayGrantClaims(
    user,
    released,
    {
      ...claims,
      grant_seq: 17,
      grants: [{ ...session, id: "new", publish: [] }],
    },
    now,
  );
  expect(churned.status).toBe("applied");
  if (churned.status !== "applied")
    throw new Error("Expected the freed slot to be usable");
  expect(churned.state.grants).toHaveLength(256);
  expect(churned.state.grants.some(({ id }) => id === "new")).toBe(true);
  expect(churned.state.grants.some(({ id }) => id === session.id)).toBe(false);
});

test("a stale token cannot rewind live grants or attach its other hubs", () => {
  const earlier = {
    ...claims,
    ...initial,
    grants: [
      { ...session, publish: ["presence"] },
      { ...machine, publish: [] },
    ],
  } satisfies RelayGrantClaims;
  const later = {
    ...claims,
    grants: [{ ...session, publish: [] }],
  } satisfies RelayGrantClaims;
  const applied = applyRelayGrantClaims(user, empty, later, now);
  if (applied.status !== "applied") throw new Error("Expected a live grant");

  for (const stale of [
    earlier,
    { ...earlier, issued_at_ms: later.issued_at_ms },
    { ...earlier, issued_at_ms: later.issued_at_ms + 1 },
    { ...earlier, grant_seq: later.grant_seq + 1 },
  ]) {
    expect(applyRelayGrantClaims(user, applied.state, stale, now)).toEqual({
      status: "refused",
      code: "stale_token",
    });
  }
  expect(
    applied.state.grants.map(({ id, publish }) => ({ id, publish })),
  ).toEqual([{ id: session.id, publish: [] }]);
  expect(applyRelayGrantClaims(user, applied.state, later, now)).toEqual(
    applied,
  );
  const tie = { ...later, grant_seq: later.grant_seq + 1 };
  expect(applyRelayGrantClaims(user, applied.state, tie, now)).toMatchObject({
    status: "applied",
    state: {
      high_water: {
        issued_at_ms: later.issued_at_ms,
        grant_seq: tie.grant_seq,
      },
    },
  });
});

test("release preserves issuance history and an exact replay cannot reattach a hub", () => {
  const applied = applyRelayGrantClaims(user, empty, claims, now);
  if (applied.status !== "applied") throw new Error("Expected a live grant");

  const released = releaseRelayGrants(applied.state, [
    session,
    { ...machine, id: session.id },
  ]);
  expect(released).toEqual({
    grants: [{ ...machine, publish: [], ...issuance, expires_at_ms: deadline }],
    high_water: issuance,
  });
  expect(releaseRelayGrants(released, [session])).toEqual(released);
  expect(applyRelayGrantClaims(user, released, claims, now)).toEqual({
    status: "applied",
    state: released,
  });
  expect(
    applyRelayGrantClaims(user, released, { ...claims, ...initial }, now),
  ).toEqual({
    status: "refused",
    code: "stale_token",
  });
  const allReleased = releaseRelayGrants(released, [machine]);
  expect(allReleased).toEqual({ grants: [], high_water: issuance });
  expect(
    applyRelayGrantClaims(user, allReleased, { ...claims, ...initial }, now),
  ).toEqual({
    status: "refused",
    code: "stale_token",
  });
  expect(applyRelayGrantClaims(user, allReleased, claims, now)).toEqual({
    status: "applied",
    state: allReleased,
  });
  const reissued = {
    ...claims,
    grant_seq: claims.grant_seq + 1,
    grants: [claims.grants[0]],
  };
  expect(applyRelayGrantClaims(user, released, reissued, now)).toMatchObject({
    status: "applied",
    state: {
      grants: [
        { ...machine, publish: [] },
        {
          ...session,
          publish: claims.grants[0].publish,
          grant_seq: reissued.grant_seq,
        },
      ],
    },
  });
});

test("pruning an expired grant cannot restore rights from an earlier token", () => {
  const shorter = {
    ...claims,
    expires_at_ms: now + 1,
    grants: [{ ...session, publish: [] }],
  } satisfies RelayGrantClaims;
  const applied = applyRelayGrantClaims(user, empty, shorter, now);
  if (applied.status !== "applied") throw new Error("Expected a live grant");

  expect(
    applyRelayGrantClaims(
      user,
      applied.state,
      { ...claims, ...initial },
      now + 1,
    ),
  ).toEqual({
    status: "refused",
    code: "stale_token",
  });
  const renewed = {
    ...claims,
    grant_seq: claims.grant_seq + 1,
    grants: [claims.grants[1]],
  };
  const pruned = applyRelayGrantClaims(user, applied.state, renewed, now + 1);
  if (pruned.status !== "applied")
    throw new Error("Expected the other hub to attach");
  expect(pruned.state.grants).toMatchObject([{ id: machine.id }]);
  expect(
    applyRelayGrantClaims(
      user,
      pruned.state,
      { ...claims, ...initial },
      now + 1,
    ),
  ).toEqual({
    status: "refused",
    code: "stale_token",
  });
});

test("grant updates refuse non-finite clock readings", () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    expect(applyRelayGrantClaims(user, empty, claims, invalid)).toEqual({
      status: "refused",
      code: "invalid_clock",
    });
  }
});
