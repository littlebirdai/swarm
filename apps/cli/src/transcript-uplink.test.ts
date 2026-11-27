import { expect, spyOn, test } from "bun:test";
import {
  createTranscriptUplink,
  type TranscriptUplinkClient,
} from "@codecast/edge-client";
import type { TranscriptAppendRequest } from "@codecast/edge-contract";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTranscriptDeadline } from "./workers/ingestDeadline";
import { SyncService } from "./syncService";
import { attachTranscriptUplink } from "./transcript-write";

const input = {
  conversationId: "conversation",
  messages: [
    {
      messageUuid: "message",
      role: "assistant" as const,
      content: "hello",
      timestamp: 10,
    },
  ],
};

test("an uplink receipt accepts the transcript write and a refusal leaves it pending", async () => {
  const sync = new SyncService({ convexUrl: "http://localhost:0" });
  const accepted: number[][] = [];
  const options = {
    onBatchAccepted: (indexes: readonly number[]) =>
      accepted.push([...indexes]),
  };
  let respond!: (
    value: Awaited<ReturnType<TranscriptUplinkClient["submit"]>>,
  ) => void;
  let seen!: () => void;
  const submitted = new Promise<void>((resolve) => {
    seen = resolve;
  });
  sync.setTranscriptUplink({
    waitForReplay: async () => {},
    submit: (write) => {
      expect(write.conversation_id).toBe(input.conversationId);
      expect(write.messages[0]).toMatchObject({
        message_uuid: "message",
        role: "assistant",
        content: "hello",
      });
      seen();
      return new Promise((resolve) => {
        respond = resolve;
      });
    },
  });
  const pending = sync.addMessages(input, options);
  await submitted;
  expect(accepted).toEqual([]);
  respond({ status: "applied", inserted: 1, ids: ["server-message"] });
  expect(await pending).toEqual({ inserted: 1, ids: ["server-message"] });

  sync.setTranscriptUplink({
    waitForReplay: async () => {},
    submit: async () => ({ status: "refused" }),
  });
  await expect(sync.addMessages(input, options)).rejects.toThrow(
    "Transcript write refused",
  );
  expect(accepted).toEqual([[0]]);
});

type LegacyCall = { name: string; args: Record<string, unknown> };

function syncFixture(onCall: (call: LegacyCall) => unknown = () => undefined) {
  const sync = new SyncService({
    convexUrl: "http://localhost:0",
    authToken: "legacy-token",
  });
  const legacy: LegacyCall[] = [];
  Object.assign(sync, {
    client: {
      async mutation(name: string, args: Record<string, unknown>) {
        const call = { name, args };
        legacy.push(call);
        return (
          onCall(call) ??
          (name === "messages:addMessage"
            ? "single-id"
            : name === "messages:deleteMessagesByUuid"
              ? { deleted: 1 }
              : { inserted: 1, ids: ["legacy-id"] })
        );
      },
    },
  });
  return { sync, legacy };
}

function wireReceipt(batch: TranscriptAppendRequest) {
  return Response.json({
    v: 1,
    batch_id: batch.batch_id,
    results: batch.writes.map(() => ({
      status: "applied",
      inserted: 1,
      ids: ["edge-id"],
    })),
  });
}

async function localUplink(
  sync: SyncService,
  respond: (
    batch: TranscriptAppendRequest,
    init?: RequestInit,
  ) => Promise<Response>,
  spool?: TranscriptAppendRequest,
) {
  const tmp = await mkdtemp(join(tmpdir(), "cli-transcript-uplink-"));
  const spoolPath = join(tmp, "spool.json");
  if (spool) await writeFile(spoolPath, JSON.stringify(spool), { mode: 0o600 });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) =>
        respond(JSON.parse(String(init?.body)), init),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const uplink = createTranscriptUplink({
    siteUrl: "https://edge.invalid",
    spoolPath,
    bearer: () => "pilot-token",
    fallback: (write) => sync.replayTranscriptWrite(write, "pilot-token"),
  });
  attachTranscriptUplink(sync, Promise.resolve(uplink), () => {});
  return {
    uplink,
    async dispose() {
      await uplink.close();
      fetch.mockRestore();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

test("an aborted ingest keeps its place ahead of deletes and single-message writes", async () => {
  const { sync, legacy } = syncFixture();
  const posted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const edge = await localUplink(sync, async (batch) => {
    posted.resolve();
    await release.promise;
    return wireReceipt(batch);
  });
  const cancel = new AbortController();
  try {
    const ingest = withTranscriptDeadline(() => sync.addMessages(input), {
      signal: cancel.signal,
    });
    await posted.promise;
    cancel.abort();
    const deleted = sync.deleteMessagesByUuid(input.conversationId, [
      "message",
    ]);
    const single = sync.addMessage({
      ...input.messages[0]!,
      conversationId: input.conversationId,
    });
    await sync.addMessage({
      ...input.messages[0]!,
      conversationId: "unrelated",
    });
    expect(legacy.map(({ args }) => args.conversation_id)).toEqual([
      "unrelated",
    ]);
    release.resolve();
    expect(await ingest).toEqual({ inserted: 1, ids: ["edge-id"] });
    expect(await deleted).toBe(1);
    expect(await single).toBe("single-id");
    expect(legacy.map(({ name }) => name)).toEqual([
      "messages:addMessage",
      "messages:deleteMessagesByUuid",
      "messages:addMessage",
    ]);
  } finally {
    release.resolve();
    await edge.dispose();
  }
});

function legacyInput(mode: string) {
  if (mode === "without uuid")
    return {
      ...input,
      messages: [{ ...input.messages[0]!, messageUuid: undefined }],
    };
  return {
    ...input,
    messages: Array.from({ length: 6 }, (_, index) => ({
      ...input.messages[0]!,
      messageUuid: `oversized-${index}`,
      content: "x".repeat(95_000),
    })),
  };
}

test.each(["single message", "oversized", "without uuid"])(
  "%s waits for the spooled session replay before writing through legacy",
  async (mode) => {
    const { sync, legacy } = syncFixture();
    const posted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const replay: TranscriptAppendRequest = {
      v: 1,
      batch_id: "previous",
      writes: [
        {
          conversation_id: input.conversationId,
          messages: [
            {
              role: "assistant",
              message_uuid: "previous",
              content: "previous turn",
            },
          ],
        },
      ],
    };
    const calls: string[] = [];
    const edge = await localUplink(
      sync,
      async (batch) => {
        calls.push(batch.batch_id);
        posted.resolve();
        await release.promise;
        return wireReceipt(batch);
      },
      replay,
    );
    try {
      const pending =
        mode === "single message"
          ? sync.addMessage({
              ...input.messages[0]!,
              conversationId: input.conversationId,
            })
          : sync.addMessages(legacyInput(mode));
      await posted.promise;
      await sync.addMessage({
        ...input.messages[0]!,
        conversationId: "unrelated",
      });
      expect(legacy.map(({ args }) => args.conversation_id)).toEqual([
        "unrelated",
      ]);
      release.resolve();
      await pending;
      expect(calls).toEqual(["previous"]);
      expect(legacy[1]).toMatchObject({
        name:
          mode === "single message"
            ? "messages:addMessage"
            : "messages:addMessages",
        args: { conversation_id: input.conversationId },
      });
    } finally {
      release.resolve();
      await edge.dispose();
    }
  },
);

test("a disabled route replays through legacy in order and skips refused rows", async () => {
  const { sync, legacy } = syncFixture(({ args }) => {
    if (args.conversation_id === "malformed")
      throw new Error(
        "[CONVEX M(messages:addMessages)] ArgumentValidationError: Object contains an invalid field.\nObject: {...}",
      );
  });
  const replay: TranscriptAppendRequest = {
    v: 1,
    batch_id: "previous",
    writes: ["malformed", input.conversationId].map((conversation_id) => ({
      conversation_id,
      messages: [{ role: "assistant", message_uuid: `old-${conversation_id}` }],
    })),
  };
  const edge = await localUplink(
    sync,
    async () => new Response(null, { status: 404 }),
    replay,
  );
  try {
    await sync.addMessage({
      ...input.messages[0]!,
      conversationId: input.conversationId,
    });
    expect(
      legacy.map(({ name, args }) => [
        name,
        args.conversation_id,
        args.api_token,
      ]),
    ).toEqual([
      ["messages:addMessages", "malformed", "pilot-token"],
      ["messages:addMessages", input.conversationId, "pilot-token"],
      ["messages:addMessage", input.conversationId, "legacy-token"],
    ]);
    expect(await sync.addMessages(input)).toEqual({
      inserted: 1,
      ids: ["legacy-id"],
    });
  } finally {
    await edge.dispose();
  }
});

test("repeated 401s wait for different bearers and replay the same batch", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cli-transcript-auth-"));
  const spoolPath = join(tmp, "spool.json");
  const request: TranscriptAppendRequest = {
    v: 1,
    batch_id: "auth",
    writes: [
      {
        conversation_id: input.conversationId,
        messages: [{ role: "assistant", message_uuid: "old" }],
      },
    ],
  };
  await writeFile(spoolPath, JSON.stringify(request));
  let readRejectedToken = false;
  const posts: [string | null, TranscriptAppendRequest][] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        const body = JSON.parse(String(init?.body));
        posts.push([authorization, body]);
        return authorization === "Bearer token-3"
          ? wireReceipt(body)
          : new Response(null, { status: 401 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const uplink = createTranscriptUplink({
    siteUrl: "https://edge.invalid",
    spoolPath,
    bearer: () => {
      if (posts.length === 1 && !readRejectedToken) {
        readRejectedToken = true;
        return "token-0";
      }
      return `token-${posts.length}`;
    },
    fallback: async () => {
      throw new Error("401 must not fall back");
    },
  });
  try {
    await uplink.start();
    expect(posts).toEqual(
      Array.from({ length: 4 }, (_, index) => [
        `Bearer token-${index}`,
        request,
      ]),
    );
  } finally {
    await uplink.close();
    fetch.mockRestore();
    await rm(tmp, { recursive: true, force: true });
  }
}, 12_000);

test("an unreadable spool stays intact while startup detaches uplink and resumes legacy writes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cli-unreadable-spool-"));
  const spoolPath = join(tmp, "spool.json");
  const corrupt = "{corrupt json";
  const { sync, legacy } = syncFixture();
  const reported = Promise.withResolvers<Error>();
  const binding = spyOn(sync, "setTranscriptUplink");
  await writeFile(spoolPath, corrupt, { mode: 0o600 });
  const uplink = createTranscriptUplink({
    spoolPath,
    siteUrl: "http://localhost:0",
    bearer: () => "fixture-token",
    fallback: async () => {
      throw new Error("must use legacy through SyncService");
    },
  });
  try {
    attachTranscriptUplink(sync, Promise.resolve(uplink), reported.resolve);
    const write = sync.addMessages(input);
    const error = await reported.promise;
    expect(error.message).toContain(spoolPath);
    expect(error.message).toContain("Invalid transcript spool JSON or UTF-8");
    expect(error.cause).toBeInstanceOf(Error);
    expect(binding).toHaveBeenLastCalledWith(undefined, expect.any(Object));
    expect(await write).toEqual({ inserted: 1, ids: ["legacy-id"] });
    await sync.deleteMessagesByUuid(input.conversationId, ["message"]);
    expect(legacy.map(({ name }) => name)).toEqual([
      "messages:addMessages",
      "messages:deleteMessagesByUuid",
    ]);
    expect(await readFile(spoolPath, "utf8")).toBe(corrupt);
    expect(await readdir(tmp)).toEqual(["spool.json"]);
  } finally {
    binding.mockRestore();
    await uplink.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
