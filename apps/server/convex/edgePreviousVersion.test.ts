import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  base64urlDecode,
  base64urlEncode,
} from "@codecast/connectors/codecastSignature";
import { TAKEOVER_FENCE_CAPABILITY } from "@codecast/edge-contract";
import { presentToken } from "@platform/auth/tokenFormat";
import * as previousEdge from "../../../packages/edge-contract/test/n-1/schema";
import { parseRelayGrantClaims as parsePreviousRelayGrantClaims } from "../../../packages/relay-contract/test/n-1/schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { edgePromptFixture } from "../test-helpers/edge-prompt.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture,
} from "../test-helpers/steer-delivery.testkit";

const EDGE_FIXTURES_DIR = join(
  import.meta.dir,
  "../../../packages/edge-contract/test/n-1/fixtures",
);
const ROUTES_PATH = join(import.meta.dir, "lib/edge/routes.ts");

function loadEdgeFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(EDGE_FIXTURES_DIR, `${name}.json`), "utf8"),
  ) as T;
}

const envFlags = {
  CODECAST_EDGE_V1: "1",
  CODECAST_EDGE_DELIVERY_V1: "1",
  CODECAST_EDGE_TRANSCRIPT_UPLINK_V1: "1",
  CODECAST_FENCED_EXECUTION_V1: "1",
  SWARM_TURN_BATON: "1",
  CODECAST_EDGE_RELAY_LIVENESS_V1: "1",
  CODECAST_EDGE_TERMINAL_EVENTS: "1",
  RELAY_PUBLIC_URL: "wss://relay.example.test/relay",
  RELAY_AUDIENCE: "fixture-cell",
  RELAY_HMAC_KEY: base64urlEncode(new Uint8Array(32).fill(4)),
};
const savedEnv = Object.entries(envFlags).map(
  ([key]) => [key, process.env[key]] as const,
);

beforeEach(() => {
  Object.assign(process.env, envFlags);
  setSystemTime(new Date(start));
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setSystemTime();
});

async function postEdge(
  t: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  operation: string,
  body: unknown,
  token: string,
) {
  return t.fetch(`/edge/v1/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("every /edge/v1 server route in routes.ts is covered by the N-1 suite", () => {
  const source = readFileSync(ROUTES_PATH, "utf8");
  const registered = new Set<string>();
  for (const match of source.matchAll(/path:\s*"(\/edge\/v1\/[^"]+)"/g)) {
    registered.add(match[1]!);
  }
  if (source.includes("TRANSCRIPT_APPEND_OPERATION")) {
    registered.add(`/edge/v1/${previousEdge.TRANSCRIPT_APPEND_OPERATION}`);
  }
  const covered = new Set([
    "/edge/v1/hello",
    "/edge/v1/heartbeat",
    "/edge/v1/claim",
    "/edge/v1/renew",
    "/edge/v1/relay-grant",
    "/edge/v1/release",
    "/edge/v1/events.append",
    "/edge/v1/commands.next",
    "/edge/v1/commands.result",
    "/edge/v1/permits.next",
    "/edge/v1/takeover.ack",
    "/edge/v1/delivery.start",
    "/edge/v1/blobs.get",
    "/edge/v1/delivery.settle",
    "/edge/v1/transcripts.append",
  ]);
  expect([...registered].sort()).toEqual([...covered].sort());
});

test("link verb group: N-1 hello and heartbeat requests decode with N-1 schema", async () => {
  const helloFixture = loadEdgeFixture<{
    request: previousEdge.HelloRequest;
  }>("hello");
  const heartbeatFixture = loadEdgeFixture<{
    request: previousEdge.HeartbeatRequest;
  }>("heartbeat");

  const t = serverTest();
  const secret = "link-n1-secret";
  const tokenHash = await hashToken(secret);
  await t.run(async ({ db }) => {
    const user = await fixtureRows(db, "edge link n-1").user();
    await db.insert("api_tokens", {
      user_id: user,
      name: "edge link n-1",
      token_hash: tokenHash,
      created_at: start,
      last_used_at: start,
      device_id: helloFixture.request.machine,
    });
  });
  const bearer = presentToken(secret, helloFixture.request.machine);

  const helloRes = await postEdge(t, "hello", helloFixture.request, bearer);
  expect(helloRes.status).toBe(200);
  const parsedHello = previousEdge.parseHelloResponse(await helloRes.json());
  expect(parsedHello.ok).toBe(true);
  if (!parsedHello.ok || parsedHello.value.status !== "ok") {
    throw new Error("Expected ok hello response");
  }
  expect(parsedHello.value.version).toBe(1);

  for (const versions of [[], [99]] as const) {
    const negRes = await postEdge(
      t,
      "hello",
      { ...helloFixture.request, versions },
      bearer,
    );
    expect(negRes.status).toBe(200);
    expect(previousEdge.parseHelloResponse(await negRes.json()).ok).toBe(true);
  }

  const hbRes = await postEdge(
    t,
    "heartbeat",
    heartbeatFixture.request,
    bearer,
  );
  expect(hbRes.status).toBe(200);
  const parsedHb = previousEdge.parseHeartbeatResponse(await hbRes.json());
  expect(parsedHb.ok).toBe(true);
});

test("claims verb group: N-1 claim, renew, relay-grant, and release decode with N-1 schema", async () => {
  const claimFixture = loadEdgeFixture<{ request: previousEdge.ClaimRequest }>(
    "claim",
  );
  const renewFixture = loadEdgeFixture<{ request: previousEdge.RenewRequest }>(
    "renew",
  );
  const relayGrantFixture = loadEdgeFixture<{
    request: previousEdge.RelayGrantRequest;
  }>("relay-grant");
  const releaseFixture = loadEdgeFixture<{
    request: previousEdge.ReleaseRequest;
  }>("release");

  const f = await setupRunLease();
  const claimRes = await postEdge(
    f.t,
    "claim",
    {
      ...claimFixture.request,
      session: f.conversation,
      machine,
      boot,
    },
    f.bearer,
  );
  expect(claimRes.status).toBe(200);
  const parsedClaim = previousEdge.parseClaimResponse(await claimRes.json());
  expect(parsedClaim.ok).toBe(true);
  if (!parsedClaim.ok || parsedClaim.value.status !== "granted") {
    throw new Error("Expected granted claim");
  }

  const fence = {
    session: parsedClaim.value.session,
    run: parsedClaim.value.run,
    fencing_token: parsedClaim.value.fencing_token,
  };

  const renewRes = await postEdge(
    f.t,
    "renew",
    { ...renewFixture.request, ...fence },
    f.bearer,
  );
  expect(renewRes.status).toBe(200);
  const parsedRenew = previousEdge.parseRenewResponse(await renewRes.json());
  expect(parsedRenew).toMatchObject({
    ok: true,
    value: { v: 1, status: "renewed" },
  });

  const grantRes = await postEdge(
    f.t,
    "relay-grant",
    { ...relayGrantFixture.request, sessions: [fence] },
    f.bearer,
  );
  expect(grantRes.status).toBe(200);
  const parsedGrant = previousEdge.parseRelayGrantResponse(
    await grantRes.json(),
  );
  expect(parsedGrant.ok).toBe(true);
  if (!parsedGrant.ok || parsedGrant.value.status !== "ok") {
    throw new Error("Expected ok relay-grant response");
  }
  const [, payload] = parsedGrant.value.token.split(".");
  const decodedClaims = parsePreviousRelayGrantClaims(
    new TextDecoder().decode(base64urlDecode(payload!)),
  );
  expect(decodedClaims.ok).toBe(true);

  const releaseRes = await postEdge(
    f.t,
    "release",
    { ...releaseFixture.request, ...fence },
    f.bearer,
  );
  expect(releaseRes.status).toBe(200);
  const parsedRelease = previousEdge.parseReleaseResponse(
    await releaseRes.json(),
  );
  expect(parsedRelease).toEqual({
    ok: true,
    value: { v: 1, status: "released" },
  });
});

test("delivery verb group: N-1 permits.next, blobs.get, delivery.start, and delivery.settle decode with N-1 schema", async () => {
  const permitsFixture = loadEdgeFixture<{
    request: previousEdge.PermitsNextRequest;
  }>("permits.next");
  const blobsFixture = loadEdgeFixture<{
    request: previousEdge.BlobsGetRequest;
  }>("blobs.get");
  const startFixture = loadEdgeFixture<{
    request: previousEdge.DeliveryStartRequest;
  }>("delivery.start");
  const settleFixture = loadEdgeFixture<{
    request: previousEdge.DeliverySettleRequest;
  }>("delivery.settle");
  const resolutionFixture = loadEdgeFixture<
    Record<string, Array<{ request: previousEdge.DeliverySettleRequest }>>
  >("delivery-resolution");

  const f = await setupRunLease();
  const payloadBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const blobId = await f.t.run(async ({ db, storage }) => {
    const id = await storage.store(
      new Blob([payloadBytes], { type: "image/png" }),
    );
    const patch = db.patch as (
      table: "_storage",
      storageId: typeof id,
      fields: { contentType: string },
    ) => Promise<void>;
    await patch("_storage", id, { contentType: "image/png" });
    await db.patch(f.message, { image_storage_id: id });
    return id;
  });

  const claim = await f.claim("delivery-n1");
  if (claim.status !== "granted") throw new Error("Expected grant");
  const fence = {
    session: f.conversation,
    run: claim.run,
    fencing_token: claim.fencing_token,
  };

  const permitRes = await postEdge(
    f.t,
    "permits.next",
    { ...permitsFixture.request, ...fence },
    f.bearer,
  );
  expect(permitRes.status).toBe(200);
  const parsedPermit = previousEdge.parsePermitsNextResponse(
    await permitRes.json(),
  );
  expect(parsedPermit.ok).toBe(true);
  if (!parsedPermit.ok || parsedPermit.value.status !== "permit") {
    throw new Error("Expected permit");
  }

  const blobRes = await postEdge(
    f.t,
    "blobs.get",
    {
      ...blobsFixture.request,
      ...fence,
      attempt_id: parsedPermit.value.attempt_id,
      blob_id: blobId,
    },
    f.bearer,
  );
  expect(blobRes.status).toBe(200);
  expect(blobRes.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await blobRes.arrayBuffer())).toEqual(payloadBytes);

  const missingBlobRes = await postEdge(
    f.t,
    "blobs.get",
    {
      ...blobsFixture.request,
      ...fence,
      attempt_id: parsedPermit.value.attempt_id,
      blob_id: "missing-blob",
    },
    f.bearer,
  );
  expect(missingBlobRes.status).toBe(404);
  expect(
    previousEdge.parseEdgeErrorResponse(await missingBlobRes.json()).ok,
  ).toBe(true);

  const deliveryBase = {
    ...fence,
    delivery_id: parsedPermit.value.delivery_id,
    attempt_id: parsedPermit.value.attempt_id,
    seq: parsedPermit.value.seq,
    intent: parsedPermit.value.intent,
    sender: parsedPermit.value.sender,
  };

  const startRes = await postEdge(
    f.t,
    "delivery.start",
    { ...startFixture.request, ...deliveryBase },
    f.bearer,
  );
  expect(startRes.status).toBe(200);
  const parsedStart = previousEdge.parseDeliveryStartResponse(
    await startRes.json(),
  );
  expect(parsedStart.ok).toBe(true);
  if (!parsedStart.ok || parsedStart.value.status !== "started") {
    throw new Error("Expected started response");
  }

  const settleRes = await postEdge(
    f.t,
    "delivery.settle",
    { ...settleFixture.request, ...deliveryBase, outcome: "applied" },
    f.bearer,
  );
  expect(settleRes.status).toBe(200);
  expect(
    previousEdge.parseDeliverySettleResponse(await settleRes.json()),
  ).toEqual({
    ok: true,
    value: { v: 1, status: "recorded" },
  });

  await f.t.run(async ({ db }) => {
    const first = await db.get(f.message);
    if (!first) throw new Error("Expected message");
    const { _id, _creationTime, ...row } = first;
    await db.insert("pending_messages", {
      ...row,
      status: "pending",
      delivery_status: "pending",
      client_id: "delivery-2",
      delivery_id: "delivery-2",
      conversation_sequence: 2,
      image_storage_id: undefined,
      created_at: start + 1,
    });
    await db.patch(f.head, { next_conversation_sequence: 3 });
  });

  const secondPermitRes = await postEdge(
    f.t,
    "permits.next",
    { ...permitsFixture.request, ...fence },
    f.bearer,
  );
  const secondPermit = previousEdge.parsePermitsNextResponse(
    await secondPermitRes.json(),
  );
  if (!secondPermit.ok || secondPermit.value.status !== "permit") {
    throw new Error("Expected second permit");
  }
  const secondBase = {
    ...fence,
    delivery_id: secondPermit.value.delivery_id,
    attempt_id: secondPermit.value.attempt_id,
    seq: secondPermit.value.seq,
    intent: secondPermit.value.intent,
    sender: secondPermit.value.sender,
  };
  expect(
    (
      await postEdge(
        f.t,
        "delivery.start",
        { ...startFixture.request, ...secondBase },
        f.bearer,
      )
    ).status,
  ).toBe(200);

  for (const step of resolutionFixture["correlated delivery"]!) {
    const res = await postEdge(
      f.t,
      "delivery.settle",
      { ...step.request, ...secondBase },
      f.bearer,
    );
    expect(res.status).toBe(200);
    expect(previousEdge.parseDeliverySettleResponse(await res.json()).ok).toBe(
      true,
    );
  }
});

test("takeover verb group: N-1 permits.next takeover_fence and takeover.ack decode with N-1 schema", async () => {
  const ackFixture = loadEdgeFixture<{
    request: previousEdge.TakeoverAckRequest;
  }>("takeover.ack");
  const f = await steerDeliveryFixture();
  await f.t.run(async ({ db }) => {
    const binding = await db.get(f.binding);
    if (!binding) throw new Error("Expected binding");
    await db.patch(f.binding, {
      capabilities: [...binding.capabilities!, TAKEOVER_FENCE_CAPABILITY],
    });
  });
  await asUser(f.t, f.other).mutation(api.collab.takeOverSteer, {
    conversation_id: f.conversation,
    expected: observed,
    expected_holder: f.owner,
    expected_token: null,
  });
  const permitRes = await postEdge(f.t, "permits.next", f.fence, f.bearer);
  expect(permitRes.status).toBe(200);
  const parsedFence = previousEdge.parsePermitsNextResponse(
    await permitRes.json(),
  );
  expect(parsedFence.ok).toBe(true);
  if (!parsedFence.ok || parsedFence.value.status !== "takeover_fence") {
    throw new Error("Expected takeover_fence");
  }
  const ackRes = await postEdge(
    f.t,
    "takeover.ack",
    {
      ...ackFixture.request,
      session: parsedFence.value.session,
      run: parsedFence.value.run,
      fencing_token: parsedFence.value.fencing_token,
      fence_id: parsedFence.value.fence_id,
      turn: parsedFence.value.turn,
      baton_token: parsedFence.value.baton_token,
    },
    f.bearer,
  );
  expect(ackRes.status).toBe(200);
  expect(previousEdge.parseTakeoverAckResponse(await ackRes.json())).toEqual({
    ok: true,
    value: { v: 1, status: "recorded" },
  });
});

test("commands verb group: N-1 commands.next and commands.result decode with N-1 schema", async () => {
  const nextFixture = loadEdgeFixture<{
    request: previousEdge.CommandsNextRequest;
  }>("commands.next");
  const resultFixture = loadEdgeFixture<{
    request: previousEdge.CommandsResultRequest;
  }>("commands.result");

  const f = await edgePromptFixture();
  await f.answer({ answers: { "question-id": { answers: ["Choice"] } } });

  const nextRes = await postEdge(
    f.t,
    "commands.next",
    { ...nextFixture.request, machine, boot },
    f.bearer,
  );
  expect(nextRes.status).toBe(200);
  const parsedNext = previousEdge.parseCommandsNextResponse(
    await nextRes.json(),
  );
  expect(parsedNext.ok).toBe(true);
  if (!parsedNext.ok || parsedNext.value.status !== "command") {
    throw new Error("Expected command");
  }

  const resultRes = await postEdge(
    f.t,
    "commands.result",
    {
      ...resultFixture.request,
      machine,
      boot,
      command_id: parsedNext.value.command_id,
      claim: parsedNext.value.claim,
    },
    f.bearer,
  );
  expect(resultRes.status).toBe(200);
  expect(
    previousEdge.parseCommandsResultResponse(await resultRes.json()),
  ).toEqual({
    ok: true,
    value: { v: 1, status: "recorded" },
  });
});

test("events verb group: N-1 events.append batch with all 17 event kinds decodes with N-1 schema", async () => {
  const eventsFixture = loadEdgeFixture<{
    request: previousEdge.EventsAppendRequest;
  }>("events.append");
  const f = await setupRunLease();
  const claim = await f.claim("events-n1");
  if (claim.status !== "granted") throw new Error("Expected grant");

  const [firstBatch, secondBatch] = eventsFixture.request.batches;
  const boundBatches = [
    {
      ...firstBatch!,
      session: f.conversation,
      run: claim.run,
      fencing_token: claim.fencing_token,
      events: firstBatch!.events.map((event) => ({
        ...event,
        session: f.conversation,
        run: claim.run,
        ...(event.kind === "terminal.ended"
          ? { body: { ...event.body, started_run: claim.run } }
          : {}),
      })),
    },
    secondBatch!,
  ];

  const appendRes = await postEdge(
    f.t,
    "events.append",
    { v: eventsFixture.request.v, batches: boundBatches },
    f.bearer,
  );
  expect(appendRes.status).toBe(200);
  const parsed = previousEdge.parseEventsAppendResponse(await appendRes.json());
  expect(parsed).toEqual({
    ok: true,
    value: {
      v: 1,
      results: [
        {
          session: f.conversation,
          status: "appended",
          through_seq: firstBatch!.events.length,
        },
        {
          session: secondBatch!.session,
          status: "stale",
        },
      ],
    },
  });
});

test("transcripts verb group: N-1 transcripts.append batch decodes with N-1 schema", async () => {
  const transcriptFixture = loadEdgeFixture<{
    request: previousEdge.TranscriptAppendRequest;
  }>("transcripts.append");
  const f = await setupRunLease();
  const foreign = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "transcripts n1 foreign");
    return rows.conversation(await rows.user());
  });

  const writes = transcriptFixture.request.writes.map((write, index) => ({
    ...write,
    conversation_id: index === 0 ? f.conversation : foreign,
    messages: write.messages.map((message) =>
      "source_device_id" in message
        ? { ...message, source_device_id: machine }
        : message,
    ),
  }));

  const appendRes = await postEdge(
    f.t,
    previousEdge.TRANSCRIPT_APPEND_OPERATION,
    { ...transcriptFixture.request, writes },
    f.bearer,
  );
  expect(appendRes.status).toBe(200);
  const parsed = previousEdge.parseTranscriptAppendResponse(
    await appendRes.json(),
  );
  expect(parsed).toEqual({
    ok: true,
    value: {
      v: 1,
      batch_id: transcriptFixture.request.batch_id,
      results: [
        { status: "applied", inserted: 1, ids: [expect.any(String)] },
        { status: "refused" },
      ],
    },
  });
});
