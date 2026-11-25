import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  type BlobsGetRequest,
} from "@codecast/edge-contract";
import {
  leaseMs,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import http from "./http";

const flag = "CODECAST_EDGE_DELIVERY_V1";
const previous = process.env[flag];
const maxBytes = 8 * 1024 * 1024;
const path = "/edge/v1/blobs.get";
const missing = { v: 1, status: "error", code: "not_found", retryable: false };
const tooLarge = { v: 1, status: "error", code: "too_large", retryable: false };

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
  setSystemTime();
});

async function fixture() {
  const f = await setupRunLease();
  const store = (data: BlobPart, type: string) =>
    f.t.run(async ({ db, storage }) => {
      const id = await storage.store(new Blob([data], { type }));
      const patch = db.patch as (
        table: "_storage",
        storageId: typeof id,
        fields: { contentType: string },
      ) => Promise<void>;
      await patch("_storage", id, { contentType: type });
      return id;
    });
  const post = (verb: string, body: unknown, token = f.bearer) =>
    f.t.fetch(`/edge/v1/${verb}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });
  const grant = async () => {
    const answer = await f.claim("edge-images");
    if (answer.status !== "granted") throw new Error("Expected a grant");
    const { v, session, run, fencing_token } = answer;
    return { v, session, run, fencing_token };
  };
  const permit = async (fence: Awaited<ReturnType<typeof grant>>) => {
    const response = await post("permits.next", fence);
    const parsed = parsePermitsNextResponse(await response.json());
    if (!parsed.ok || parsed.value.status !== "permit")
      throw new Error("Expected permit");
    const { attempt_id, delivery_id, seq, intent, sender, input } =
      parsed.value;
    return {
      request: { ...fence, attempt_id, delivery_id, seq, intent, sender },
      input,
    };
  };
  const authorize = async () => {
    const blob = await store("image bytes", "image/png");
    await f.t.run(({ db }) => db.patch(f.message, { image_storage_id: blob }));
    const fence = await grant();
    const { request } = await permit(fence);
    const body = { ...fence, attempt_id: request.attempt_id, blob_id: blob };
    return { blob, fence, request, body };
  };
  const runBlobAction = async (
    body: BlobsGetRequest,
    get: (id: string) => Promise<unknown>,
  ) => {
    const [action] = http.lookup(path, "POST")!;
    return action._handler(
      {
        runQuery: f.t.query,
        runMutation: f.t.mutation,
        storage: { get },
      } as Parameters<typeof action._handler>[0],
      new Request(`https://test.example${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.bearer}` },
        body: JSON.stringify(body),
      }),
    );
  };
  return { ...f, store, post, grant, permit, authorize, runBlobAction };
}

async function expectMissing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual(missing);
}

test("start and permit responses carry ordered image parts and the active permit reads raw bytes", async () => {
  const f = await fixture();
  const bytes = new Uint8Array([0, 137, 80, 255, 10]);
  const first = await f.store(bytes, "image/png");
  const second = await f.store("webp bytes", "image/webp");
  await f.t.run(({ db }) =>
    db.patch(f.message, {
      image_storage_id: first,
      image_storage_ids: [first, second],
    }),
  );
  const fence = await f.grant();
  const { request, input } = await f.permit(fence);
  expect(input).toEqual([
    { type: "text", text: "queued" },
    { type: "blob", blob_id: first, content_type: "image/png" },
    { type: "blob", blob_id: second, content_type: "image/webp" },
  ]);
  const body = { ...fence, attempt_id: request.attempt_id, blob_id: first };
  const initial = await f.post("blobs.get", body);
  expect(initial.status).toBe(200);
  expect(initial.headers.get("Content-Type")).toBe("image/png");
  expect(initial.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(initial.headers.get("Content-Disposition")).toBe("attachment");
  expect(initial.headers.get("Location")).toBeNull();
  expect(new Uint8Array(await initial.arrayBuffer())).toEqual(bytes);

  for (const status of ["started", "already_started"]) {
    const begin = await f.post("delivery.start", request);
    const wire = parseDeliveryStartResponse(await begin.json());
    expect(wire).toEqual({ ok: true, value: { ...request, status, input } });
  }
  const replay = await f.post("blobs.get", body);
  expect(new Uint8Array(await replay.arrayBuffer())).toEqual(bytes);
  const settled = await f.post("delivery.settle", {
    ...request,
    outcome: "applied",
  });
  expect(await settled.json()).toMatchObject({ status: "recorded" });
  await expectMissing(await f.post("blobs.get", body));
});

test("blob authorization returns one typed 404 for foreign, unknown, deleted, expired and wrong-device reads", async () => {
  const f = await fixture();
  const { blob, body } = await f.authorize();
  const another = await f.store("outside this permit", "image/png");
  const missingBlob = await f.store("deleted", "image/png");
  await f.t.run(async ({ db, storage }) => {
    await db.patch(f.message, { image_storage_ids: [missingBlob] });
    await storage.delete(missingBlob);
  });
  for (const response of [
    await f.post("blobs.get", body, f.wrongDevice),
    await f.post("blobs.get", body, f.wrongUser),
    await f.post("blobs.get", { ...body, blob_id: another }),
    await f.post("blobs.get", { ...body, blob_id: missingBlob }),
    await f.post("blobs.get", { ...body, blob_id: "unknown" }),
    await f.post("blobs.get", {
      ...body,
      blob_id: blob,
      attempt_id: "another-permit",
    }),
    await f.post("blobs.get", { ...body, fencing_token: "not-the-lease" }),
    await f.post("blobs.get", { ...body, run: body.run + 1 }),
  ])
    await expectMissing(response);

  expect((await f.post("blobs.get", body, f.unbound)).status).toBe(401);
  setSystemTime(new Date(start + leaseMs));
  await expectMissing(await f.post("blobs.get", body));
});

test("a superseded attempt cannot read an image even when the new permit grants it", async () => {
  const f = await fixture();
  const { blob, body, fence, request } = await f.authorize();
  await f.post("delivery.start", request);
  await f.post("delivery.settle", {
    ...request,
    outcome: "failed",
    retryable: true,
  });
  const { request: next } = await f.permit(fence);
  expect(next.attempt_id).not.toBe(body.attempt_id);
  await expectMissing(await f.post("blobs.get", body));
  const active = await f.post("blobs.get", {
    ...fence,
    attempt_id: next.attempt_id,
    blob_id: blob,
  });
  expect(active.status).toBe(200);
});

test("oversized and unsupported attachments stay queued without a delivery attempt", async () => {
  const f = await fixture();
  const fence = await f.grant();
  const large = await f.store(new Uint8Array(maxBytes + 1), "image/png");
  const svg = await f.store("<svg/>", "image/svg+xml");
  for (const [id, status, error] of [
    [large, 413, tooLarge],
    [svg, 422, { v: 1, status: "error", code: "invalid", retryable: false }],
  ] as const) {
    await f.t.run(({ db }) => db.patch(f.message, { image_storage_id: id }));
    const refused = await f.post("permits.next", fence);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual(error);
  }
  expect(
    await f.t.run(({ db }) => db.query("delivery_attempts").collect()),
  ).toEqual([]);
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "pending",
  );
});

test("read refuses oversized storage metadata before asking storage for bytes", async () => {
  const f = await fixture();
  const large = await f.store(new Uint8Array(maxBytes + 1), "image/png");
  await f.t.run(({ db }) => db.patch(f.message, { image_storage_id: large }));
  const legacy = await f.deliver();
  expect(legacy.state).toBe("claimed");
  const fence = await f.grant();
  const response = await f.runBlobAction(
    {
      ...fence,
      attempt_id: legacy.permit.attemptId,
      blob_id: large,
    },
    async () => {
      throw new Error("Storage must not read oversized bytes");
    },
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual(tooLarge);
});

test("a blob at the advertised byte limit is readable", async () => {
  const f = await fixture();
  const blobId = await f.store(new Uint8Array(maxBytes), "image/png");
  await f.t.run(({ db }) => db.patch(f.message, { image_storage_id: blobId }));
  const fence = await f.grant();
  const { request } = await f.permit(fence);
  const file = await f.post("blobs.get", {
    ...fence,
    attempt_id: request.attempt_id,
    blob_id: blobId,
  });
  expect(file.status).toBe(200);
  expect((await file.arrayBuffer()).byteLength).toBe(maxBytes);
});

test("read checks Blob size before streaming and stops a stream that exceeds the limit", async () => {
  const f = await fixture();
  const { body } = await f.authorize();
  await expectMissing(await f.runBlobAction(body, async () => null));
  const oversized = await f.runBlobAction(body, async () => ({
    size: maxBytes + 1,
    stream: () => {
      throw new Error("An oversized Blob must not be read");
    },
  }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual(tooLarge);
  let cancelled = false;
  const streamed = await f.runBlobAction(body, async () => ({
    size: 1,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(maxBytes));
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          cancelled = true;
        },
      }),
  }));
  expect(streamed.status).toBe(413);
  expect(await streamed.json()).toEqual(tooLarge);
  expect(cancelled).toBe(true);
});

test("blob reads keep their own admission budget", async () => {
  const f = await fixture();
  const { body, fence } = await f.authorize();
  for (let i = 0; i < 120; i++)
    expect((await f.post("blobs.get", body)).status).toBe(200);
  const limited = await f.post("blobs.get", body);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");
  expect((await f.post("permits.next", fence)).status).toBe(200);
  expect(await (await f.post("renew", fence)).json()).toMatchObject({
    status: "renewed",
  });
});

test("blob reads apply flag, bearer, byte and strict parser checks before admission", async () => {
  const f = await fixture();
  const body = {
    v: 1,
    session: f.conversation,
    run: 1,
    fencing_token: "fence",
    attempt_id: "permit",
    blob_id: "blob",
  };
  delete process.env[flag];
  const disabled = await f.post("blobs.get", body, "");
  expect(disabled.status).toBe(404);
  expect(await disabled.text()).toBe(`No HttpAction routed for ${path}`);
  process.env[flag] = "1";
  const big = { ...body, blob_id: "x".repeat(65_536) };
  expect((await f.post("blobs.get", big, "")).status).toBe(401);
  expect((await f.post("blobs.get", big)).status).toBe(413);
  expect(
    (await f.post("blobs.get", { ...body, machine: "unexpected" })).status,
  ).toBe(400);
  expect((await f.post("blobs.get", body, "unknown-token")).status).toBe(401);
  expect(
    await f.t.run(({ db }) => db.query("ip_rate_limits").collect()),
  ).toEqual([]);
});
