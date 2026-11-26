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
import { api } from "./_generated/api";
import { asUser } from "../test-helpers/database.testkit";
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
    runQuery = f.t.query,
  ) => {
    const [action] = http.lookup(path, "POST")!;
    return action._handler(
      {
        runQuery,
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
  const first = await f.store(bytes, "IMAGE/PNG");
  const second = await f.store("webp bytes", "image/webp");
  await f.t.run(({ db }) =>
    db.patch(f.message, {
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
  expect(initial.headers.get("Cache-Control")).toBe("private, no-store");
  expect(new Uint8Array(await initial.arrayBuffer())).toEqual(bytes);
  const storageType = await f.runBlobAction(
    body,
    async () => new Blob([bytes], { type: "text/html" }),
  );
  expect(storageType.headers.get("Content-Type")).toBe("image/png");

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

for (const problem of ["missing", "oversized", "unsupported"] as const) {
  for (const entry of ["next", "replayed next", "start"] as const) {
    test(`${entry} rejects ${problem} images, records the reason and delivers the next message`, async () => {
      const f = await fixture();
      const image =
        problem === "oversized"
          ? await f.store(new Uint8Array(maxBytes + 1), "image/png")
          : await f.store(
              "<svg/>",
              problem === "unsupported" ? "image/svg+xml" : "image/png",
            );
      await f.t.run(async ({ db, storage }) => {
        const first = await db.get(f.message);
        if (!first) throw new Error("Expected a message");
        await db.patch(f.message, {
          content: "[Image]",
          image_storage_id: image,
        });
        if (problem === "missing") await storage.delete(image);
        const { _id, _creationTime, ...row } = first;
        await db.insert("pending_messages", {
          ...row,
          client_id: "second",
          delivery_id: "second",
          conversation_sequence: 2,
          created_at: start + 1,
        });
        await db.patch(f.head, { next_conversation_sequence: 3 });
      });
      const legacy = entry !== "next" ? await f.deliver() : undefined;
      const fence = await f.grant();
      const reason = {
        missing: "The attached images are missing and the message has no text.",
        oversized: "An image exceeds the 8 MiB delivery limit.",
        unsupported: "An image has an unsupported content type.",
      }[problem];
      const legacyRequest = legacy && {
        ...fence,
        attempt_id: legacy.permit.attemptId,
        delivery_id: legacy.permit.deliveryId,
        seq: Number(legacy.permit.conversationSequence),
        intent: "queue",
        sender: { kind: "person", id: f.owner },
      };
      if (entry === "start" && legacyRequest) {
        expect(
          await (await f.post("delivery.start", legacyRequest)).json(),
        ).toEqual({ v: 1, status: "rejected", reason });
      } else {
        expect(await (await f.post("permits.next", fence)).json()).toEqual({
          v: 1,
          status: "empty",
        });
      }
      const rejected = await f.t.run(({ db }) =>
        db.query("delivery_attempts").unique(),
      );
      expect(rejected).toMatchObject({
        state: "failed-before-effect",
        failure_message: reason,
      });
      if (legacy) expect(rejected?._id).toBe(legacy.permit.attemptId);
      const { request: second } = await f.permit(fence);
      expect(second).toMatchObject({ delivery_id: "second", seq: 2 });
      if (entry === "start" && legacyRequest) {
        setSystemTime(new Date(start + 10));
        expect(
          await (await f.post("delivery.start", legacyRequest)).json(),
        ).toEqual({ v: 1, status: "rejected", reason });
      } else {
        expect((await f.permit(fence)).request).toEqual(second);
      }
      expect(await f.t.run(({ db }) => db.get(rejected!._id))).toEqual(
        rejected,
      );
      expect(
        await (await f.post("delivery.start", second)).json(),
      ).toMatchObject({ status: "started" });
      expect(
        await (
          await f.post("delivery.settle", { ...second, outcome: "applied" })
        ).json(),
      ).toEqual({ v: 1, status: "recorded" });
      const queue = await asUser(f.t, f.owner).query(
        api.pendingMessages.cliQueue,
        { session: f.conversation },
      );
      expect(queue.cancelled).toMatchObject([
        { message_id: f.message, hold_reason: reason },
      ]);
      expect(queue.queued).toEqual([]);
    });
  }
}

for (const keeps of ["text", "image"] as const) {
  test(`start returns the surviving ${keeps} when an image disappears after the permit`, async () => {
    const f = await fixture();
    const deleted = await f.store("deleted", "image/png");
    const retained = await f.store("retained", "image/png");
    const keepImage = keeps === "image";
    await f.t.run(({ db }) =>
      db.patch(f.message, {
        content: keepImage ? "[image]" : "queued",
        image_storage_ids: keepImage ? [deleted, retained] : [deleted],
      }),
    );
    const fence = await f.grant();
    const { request, input: before } = await f.permit(fence);
    expect(before).toContainEqual({
      type: "blob",
      blob_id: deleted,
      content_type: "image/png",
    });
    await f.t.run(({ storage }) => storage.delete(deleted));
    const input = keepImage
      ? [{ type: "blob", blob_id: retained, content_type: "image/png" }]
      : [{ type: "text", text: "queued" }];
    expect(await f.permit(fence)).toEqual({ request, input });
    for (const status of ["started", "already_started"]) {
      const response = await f.post("delivery.start", request);
      expect(parseDeliveryStartResponse(await response.json())).toEqual({
        ok: true,
        value: { ...request, status, input },
      });
    }
  });
}

for (const state of ["delivery-started", "ambiguous"] as const) {
  test(`an invalid image leaves a ${state} attempt open for applied settlement`, async () => {
    const f = await fixture();
    await f.t.run(({ db }) =>
      db.patch(f.message, {
        content: "[image]",
        from_conversation_id: f.conversation,
      }),
    );
    const { blob, fence, request } = await f.authorize();
    expect(
      await (await f.post("delivery.start", request)).json(),
    ).toMatchObject({ status: "started" });
    if (state === "ambiguous")
      expect(
        await (
          await f.post("delivery.settle", { ...request, outcome: "in_doubt" })
        ).json(),
      ).toMatchObject({ status: "recorded" });
    await f.t.run(({ storage }) => storage.delete(blob));
    const next = await f.post("permits.next", fence);
    expect(await next.json()).toMatchObject({
      status: "permit",
      state: "started",
      attempt_id: request.attempt_id,
      input: [],
    });
    const replay = await f.post("delivery.start", request);
    expect(await replay.json()).toMatchObject(
      state === "ambiguous"
        ? { status: "rejected", reason: "stale" }
        : { status: "already_started", input: [] },
    );
    const status = () =>
      asUser(f.t, f.owner).query(api.pendingMessages.sendStatus, {
        from: f.conversation,
        to: f.conversation,
      });
    expect((await status()).sends).toMatchObject([{ status: "pending" }]);
    expect(
      (await f.t.run(({ db }) => db.get(f.head)))?.active_delivery_state,
    ).toBe(state);
    const outcome = {
      ...request,
      outcome: "applied",
      ...(state === "ambiguous"
        ? {
            resolution_evidence: "The transcript contains the delivery receipt",
          }
        : {}),
    };
    expect(await (await f.post("delivery.settle", outcome)).json()).toEqual({
      v: 1,
      status: "recorded",
    });
    expect((await status()).sends).toMatchObject([{ status: "delivered" }]);
  });
}

test("a recovery permit keeps text and valid images after other images become invalid", async () => {
  const f = await fixture();
  const first = await f.store("original", "image/png");
  const valid = await f.store("valid", "image/gif");
  const oversized = await f.store(new Uint8Array(maxBytes + 1), "image/png");
  const unsupported = await f.store("<svg/>", "image/svg+xml");
  const text = "Keep [Image 2] and this caption.";
  await f.t.run(({ db }) =>
    db.patch(f.message, { content: text, image_storage_ids: [first, valid] }),
  );
  const fence = await f.grant();
  const { request } = await f.permit(fence);
  await f.post("delivery.start", request);
  await f.t.run(({ db }) =>
    db.patch(f.message, { image_storage_ids: [oversized, valid, unsupported] }),
  );
  const next = await f.post("permits.next", fence);
  expect(await next.json()).toMatchObject({
    status: "permit",
    state: "started",
    input: [
      { type: "text", text },
      { type: "blob", blob_id: valid, content_type: "image/gif" },
    ],
  });
  expect(
    await (
      await f.post("delivery.settle", { ...request, outcome: "applied" })
    ).json(),
  ).toEqual({ v: 1, status: "recorded" });
});

test("bracketed words about an image are text with or without the image", async () => {
  const f = await fixture();
  const { blob, fence } = await f.authorize();
  const content = "[Image is broken]";
  await f.t.run(({ db }) => db.patch(f.message, { content }));
  expect(await (await f.post("permits.next", fence)).json()).toMatchObject({
    input: [
      { type: "text", text: content },
      { type: "blob", blob_id: blob },
    ],
  });
  await f.t.run(({ storage }) => storage.delete(blob));
  expect(await (await f.post("permits.next", fence)).json()).toMatchObject({
    input: [{ type: "text", text: content }],
  });
});

test("an invalid started image requeues on proven no effect and rejects only its new claim", async () => {
  const f = await fixture();
  const { blob, fence, request } = await f.authorize();
  await f.t.run(({ db }) =>
    db.patch(f.message, { content: "[Image 1] [image]\n [Image 2]" }),
  );
  await f.post("delivery.start", request);
  await f.t.run(({ storage }) => storage.delete(blob));
  expect(
    await (
      await f.post("delivery.settle", {
        ...request,
        outcome: "failed",
        retryable: true,
      })
    ).json(),
  ).toEqual({
    v: 1,
    status: "recorded",
  });
  expect((await f.t.run(({ db }) => db.get(f.message)))?.delivery_status).toBe(
    "pending",
  );
  expect(await (await f.post("permits.next", fence)).json()).toEqual({
    v: 1,
    status: "empty",
  });
  const attempts = await f.t.run(({ db }) =>
    db.query("delivery_attempts").collect(),
  );
  expect(attempts).toHaveLength(2);
  expect(
    attempts.find((attempt) => attempt._id !== request.attempt_id),
  ).toMatchObject({
    state: "failed-before-effect",
    failure_message:
      "The attached images are missing and the message has no text.",
  });
});

test("terminal settlement refuses mismatched head and message state", async () => {
  const f = await fixture();
  const { request } = await f.authorize();
  const reject = { ...request, outcome: "rejected" };
  await f.t.run(({ db }) =>
    db.patch(f.head, { active_delivery_state: "ambiguous" }),
  );
  expect(await (await f.post("delivery.settle", reject)).json()).toEqual({
    v: 1,
    status: "stale",
  });
  await f.t.run(async ({ db }) => {
    await db.patch(f.head, { active_delivery_state: "claimed" });
    await db.patch(f.message, { delivery_status: "ambiguous" });
  });
  expect(await (await f.post("delivery.settle", reject)).json()).toEqual({
    v: 1,
    status: "stale",
  });
  expect(
    (await f.t.run(({ db }) => db.query("delivery_attempts").unique()))?.state,
  ).toBe("claimed");
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
  await expectMissing(await f.post("blobs.get", body, f.wrongDevice));
  await expectMissing(await f.post("blobs.get", body, f.wrongUser));
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

test("blob reads refuse inconsistent head or message state", async () => {
  const f = await fixture();
  const { body } = await f.authorize();
  await f.t.run(({ db }) =>
    db.patch(f.head, { active_delivery_state: "ambiguous" }),
  );
  await expectMissing(await f.post("blobs.get", body));
  await f.t.run(async ({ db }) => {
    await db.patch(f.head, { active_delivery_state: "claimed" });
    await db.patch(f.message, { delivery_status: "ambiguous" });
  });
  await expectMissing(await f.post("blobs.get", body));
});

test("the active ambiguous attempt retains blob access for recovery", async () => {
  const f = await fixture();
  const { body, request } = await f.authorize();
  await f.post("delivery.start", request);
  expect(
    await (
      await f.post("delivery.settle", { ...request, outcome: "in_doubt" })
    ).json(),
  ).toMatchObject({ status: "recorded" });
  const response = await f.post("blobs.get", body);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("image bytes");
});

for (const change of [
  "lease expiration",
  "settlement",
  "type change",
  "invalid type",
] as const) {
  test(`the read denies a permit after ${change} during storage access`, async () => {
    const f = await fixture();
    const { blob, body, request } = await f.authorize();
    await f.post("delivery.start", request);
    const response = await f.runBlobAction(body, async () => ({
      size: 1,
      stream: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            if (change === "lease expiration")
              setSystemTime(new Date(start + leaseMs));
            if (change === "settlement")
              expect(
                await (
                  await f.post("delivery.settle", {
                    ...request,
                    outcome: "applied",
                  })
                ).json(),
              ).toMatchObject({ status: "recorded" });
            if (change === "type change" || change === "invalid type")
              await f.t.run(async ({ db }) => {
                const patch = db.patch as (
                  table: "_storage",
                  storageId: typeof blob,
                  fields: { contentType: string },
                ) => Promise<void>;
                await patch("_storage", blob, {
                  contentType:
                    change === "type change" ? "image/webp" : "image/svg+xml",
                });
              });
            controller.enqueue(Uint8Array.of(1));
            controller.close();
          },
        }),
    }));
    await expectMissing(response);
  });
}

test("an unexpected post-read query failure returns a redacted retryable 503", async () => {
  const f = await fixture();
  const { body } = await f.authorize();
  let read = false;
  const response = await f.runBlobAction(
    body,
    async () => {
      read = true;
      return new Blob(["image bytes"]);
    },
    async (...args) => {
      if (read) throw new Error("Internal storage query failure");
      return f.t.query(...args);
    },
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toEqual({
    v: 1,
    status: "error",
    code: "unavailable",
    retryable: true,
    retry_after_ms: 1_000,
  });
});

test("edge work refuses a run when the conversation owner device is unset", async () => {
  const f = await fixture();
  const { fence, request, body } = await f.authorize();
  await f.t.run(({ db }) =>
    db.patch(f.conversation, { owner_device_id: undefined }),
  );
  for (const verb of ["renew", "permits.next", "release"])
    expect(await (await f.post(verb, fence)).json()).toMatchObject({
      status: "stale",
    });
  expect(await (await f.post("delivery.start", request)).json()).toMatchObject({
    status: "rejected",
    reason: "stale",
  });
  expect(
    await (
      await f.post("delivery.settle", { ...request, outcome: "rejected" })
    ).json(),
  ).toMatchObject({ status: "stale" });
  const append = await f.post("events.append", {
    v: 1,
    batches: [
      {
        session: fence.session,
        run: fence.run,
        fencing_token: fence.fencing_token,
        events: [
          {
            v: 1,
            session: fence.session,
            run: fence.run,
            at: start,
            seq: 1,
            turn: "turn",
            source: "provider",
            kind: "turn.started",
            body: {},
          },
        ],
      },
    ],
  });
  expect(await append.json()).toMatchObject({ results: [{ status: "stale" }] });
  await expectMissing(await f.post("blobs.get", body));
});

test.each(["claimed", "started"] as const)(
  "the old device cannot read a blob from a %s attempt after the conversation leaves it",
  async (state) => {
    const f = await fixture();
    const { request, body } = await f.authorize();
    expect((await f.post("blobs.get", body)).status).toBe(200);
    if (state === "started")
      expect(
        await (await f.post("delivery.start", request)).json(),
      ).toMatchObject({ status: "started" });
    await f.t.run(({ db }) =>
      db.patch(f.conversation, { owner_device_id: "destination" }),
    );
    await expectMissing(await f.post("blobs.get", body));
    if (state === "started")
      expect(
        await (
          await f.post("delivery.settle", { ...request, outcome: "applied" })
        ).json(),
      ).toMatchObject({ status: "recorded" });
  },
);
