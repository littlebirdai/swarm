import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import {
  EDGE_PROTOCOL_VERSION as v,
  parseDeliverySettleResponse,
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  type CanonicalEvent,
  type DeliverySettleRequest,
  type DeliveryResolutionRequest,
  type EdgeParseResult,
  type PermitsNextResponse,
} from "@codecast/edge-contract";
import type {
  DeliveryReceiptJournal,
  OwnedSession,
  SteerRequest,
} from "@codecast/provider-contract";
import type { ExecutionCoordinator } from "./coordinator.js";
import { structuredFailure, type DriverDeliveryResult } from "./types.js";

type FetchEdge = (
  operation: string,
  request: object,
  signal: AbortSignal,
) => Promise<Response>;

export async function readEdge<T>(
  fetch: FetchEdge,
  signal: AbortSignal,
  operation: string,
  request: object,
  parse: (input: unknown) => EdgeParseResult<T>,
): Promise<T> {
  const response = await fetch(operation, request, signal);
  const result = parse(await response.json());
  if (!result.ok) throw result.error;
  return result.value;
}

export function deliveryFence({
  session,
  run,
  fencing_token,
}: Pick<ClaimGrant, "session" | "run" | "fencing_token">) {
  return { session, run, fencing_token };
}

type PilotPermit = Extract<PermitsNextResponse, { status: "permit" }>;

function permitIdentity(permit: PilotPermit) {
  const {
    session,
    run,
    fencing_token,
    attempt_id,
    delivery_id,
    seq,
    intent,
    sender,
  } = permit;
  return {
    session,
    run,
    fencing_token,
    attempt_id,
    delivery_id,
    seq,
    intent,
    sender,
  };
}

export class CodexPilotDelivery {
  receiptJournal?: DeliveryReceiptJournal;
  private readonly appendedReceipts = new Set<string>();
  private readonly images = new Map<string, string>();
  private activeTurn: string | null = null;
  private headDeliveryId: string | null = null;

  constructor(
    private readonly fetch: FetchEdge,
    private readonly log: (message: string) => void,
  ) {}

  private async forgetReceipt(
    session: string,
    checkpoint: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.receiptJournal?.forget(
        session,
        checkpoint,
        deliveryId,
        signal,
      );
    } catch (error) {
      this.log(
        `[owned-codex] could not remove a settled receipt: ${String(error)}`,
      );
    }
  }

  async pruneSettledReceipts(
    session: string,
    checkpoint: string,
    pendingDeliveryId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const records = await this.receiptJournal?.read(
      session,
      checkpoint,
      signal,
    );
    for (const { delivery_id } of records ?? []) {
      if (delivery_id !== pendingDeliveryId)
        await this.forgetReceipt(session, checkpoint, delivery_id, signal);
    }
  }

  async clearImages(attemptId?: string): Promise<void> {
    if (attemptId === undefined) {
      await Promise.all(
        [...this.images.keys()].map((id) => this.clearImages(id)),
      );
      return;
    }
    const directory = this.images.get(attemptId);
    if (!directory) return;
    this.images.delete(attemptId);
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  async observe(
    event: CanonicalEvent,
    session: OwnedSession,
    signal: AbortSignal,
  ): Promise<void> {
    if (event.kind === "receipt") {
      const { delivery_id } = event.body;
      if (delivery_id === this.headDeliveryId)
        this.appendedReceipts.add(delivery_id);
      else
        await this.forgetReceipt(
          event.session,
          session.getCheckpoint(),
          delivery_id,
          signal,
        );
    }
    if (event.kind === "turn.started") this.activeTurn = event.turn;
    if (event.kind === "turn.ended" && this.activeTurn === event.turn)
      this.activeTurn = null;
  }

  async nextPermit(
    claim: ClaimGrant,
    signal: AbortSignal,
  ): Promise<PilotPermit | undefined> {
    const next = await readEdge(
      this.fetch,
      signal,
      "permits.next",
      { v, ...deliveryFence(claim) },
      parsePermitsNextResponse,
    );
    if (next.status === "stale")
      throw new Error("Owned Codex delivery lease is stale");
    if (next.status === "empty") {
      this.headDeliveryId = null;
      return;
    }
    if (next.status === "error")
      throw new Error(`Owned Codex delivery lookup failed: ${next.code}`);
    if (
      next.session !== claim.session ||
      next.run !== claim.run ||
      next.fencing_token !== claim.fencing_token
    )
      throw new Error("Owned Codex permit does not match the lease");
    this.headDeliveryId = next.delivery_id;
    return next;
  }

  async drain(
    binding: ReadyBinding,
    coordinator: ExecutionCoordinator,
    session: OwnedSession,
    claim: ClaimGrant,
    prepareText: (text: string) => Promise<string>,
    signal: AbortSignal,
    sendNew: boolean,
  ): Promise<boolean> {
    const { conversationId, runtimeId } = binding;
    for (let count = 0; count < 1024 && !signal.aborted; count++) {
      const permit = await this.nextPermit(claim, signal);
      const held = coordinator.getActiveDelivery(conversationId);
      if (held) {
        const released = await coordinator.reconcileOwnedDelivery(
          conversationId,
          held.attemptId,
          async () => {
            if (
              !permit ||
              permit.attempt_id !== held.attemptId ||
              permit.state === "new"
            ) {
              if (permit?.delivery_id !== held.deliveryId) {
                this.appendedReceipts.delete(held.deliveryId);
                await this.forgetReceipt(
                  claim.session,
                  session.getCheckpoint(),
                  held.deliveryId,
                  signal,
                );
              }
              await this.clearImages(held.attemptId);
              return "released";
            }
            if (!this.appendedReceipts.has(permit.delivery_id)) return "held";
            await this.settleDelivery(session, permit, signal, {
              state: "delivered",
              externalDeliveryId: permit.delivery_id,
            });
            return "applied";
          },
        );
        if (!released) return false;
      }
      if (!permit) return true;
      if (!sendNew && permit.state === "new") return true;
      const turn = permit.intent === "queue" ? null : permit.expected?.turn;
      if (
        permit.state === "new" &&
        !this.appendedReceipts.has(permit.delivery_id) &&
        (turn === undefined || turn !== this.activeTurn)
      )
        return false;
      const identity = permitIdentity(permit);
      const outcome = await coordinator.runDeliveryOperation({
        identity: {
          conversationId,
          runtimeId,
          attemptId: permit.attempt_id,
          deliveryId: permit.delivery_id,
        },
        signature: JSON.stringify(identity),
        effect: async () => {
          if (permit.state === "new")
            return this.sendDelivery(
              session,
              permit,
              turn ?? null,
              prepareText,
              signal,
            );
          return this.appendedReceipts.has(permit.delivery_id)
            ? { state: "delivered", externalDeliveryId: permit.delivery_id }
            : {
                state: "ambiguous",
                failure: {
                  code: "OWNED_CODEX_RECEIPT_PENDING",
                  message: "Delivery awaits a Codex receipt",
                },
              };
        },
        settle: (result) =>
          this.settleDelivery(session, permit, signal, result),
      });
      if (outcome.state !== "delivered") return false;
    }
    return false;
  }

  private async sendDelivery(
    session: OwnedSession,
    permit: PilotPermit,
    turn: string | null,
    prepareText: (text: string) => Promise<string>,
    signal: AbortSignal,
  ): Promise<DriverDeliveryResult> {
    const identity = permitIdentity(permit);
    const started = await readEdge(
      this.fetch,
      signal,
      "delivery.start",
      { v, ...identity },
      parseDeliveryStartResponse,
    );
    if (
      started.status !== "started" ||
      JSON.stringify(
        permitIdentity({ ...permit, ...started, status: "permit" }),
      ) !== JSON.stringify(identity)
    )
      return {
        state: "ambiguous",
        failure: {
          code: "OWNED_CODEX_START_UNCONFIRMED",
          message: "The server did not grant a new delivery start",
        },
      };

    if (this.appendedReceipts.has(permit.delivery_id))
      return { state: "delivered", externalDeliveryId: permit.delivery_id };

    const input: Array<SteerRequest["input"][number]> = [];
    let images: string | undefined;
    try {
      for (const part of started.input ?? permit.input) {
        if (part.type === "text") {
          input.push({ type: "text", text: await prepareText(part.text) });
          continue;
        }
        const response = await this.fetch(
          "blobs.get",
          {
            v,
            session: permit.session,
            run: permit.run,
            fencing_token: permit.fencing_token,
            attempt_id: permit.attempt_id,
            blob_id: part.blob_id,
          },
          signal,
        );
        if (response.headers.get("Content-Type") !== part.content_type)
          throw new Error("Delivery image content type changed");
        images ??= await mkdtemp(join(tmpdir(), "owned-codex-image-"));
        this.images.set(permit.attempt_id, images);
        const extension = part.content_type.match(
          /^image\/(jpeg|png|webp|gif|heic|heif)$/,
        )?.[1];
        if (!extension)
          throw new Error("Unsupported delivery image content type");
        const bytes = Buffer.from(await response.arrayBuffer());
        const path = join(images, `${input.length}.${extension}`);
        await writeFile(path, bytes, { mode: 0o600 });
        const { isHeicImage, heicToJpeg } = await import("../heicImage.js");
        const jpg = join(images, `${input.length}.jpg`);
        const localPath =
          isHeicImage(bytes) && (await heicToJpeg(path, jpg)) ? jpg : path;
        input.push({ type: "local-image", path: localPath });
      }
    } catch (error) {
      await this.clearImages(permit.attempt_id);
      return {
        state: "failed-before-effect",
        failure: {
          ...structuredFailure("OWNED_CODEX_INPUT_PREPARATION", error),
          retryable: true,
        },
      };
    }

    signal.throwIfAborted();
    const result = await session.steer({
      expected: {
        run: permit.run,
        fencing_token: permit.fencing_token,
        turn,
      },
      delivery_id: permit.delivery_id,
      authors: [permit.sender],
      input,
    });
    if (
      this.appendedReceipts.has(permit.delivery_id) ||
      (result.status === "duplicate" &&
        result.receipt.delivery_id === permit.delivery_id)
    )
      return { state: "delivered", externalDeliveryId: permit.delivery_id };
    if (
      result.status === "stale" ||
      result.status === "refused" ||
      result.status === "unsupported"
    )
      return {
        state: "failed-before-effect",
        failure: {
          code:
            result.status === "refused"
              ? result.code
              : "OWNED_CODEX_DELIVERY_" + result.status.toUpperCase(),
          message:
            result.status === "refused"
              ? result.message
              : `Codex delivery was ${result.status}`,
          retryable: result.status === "stale",
        },
      };
    return {
      state: "ambiguous",
      failure:
        result.status === "in-doubt"
          ? { code: result.code, message: result.message }
          : {
              code: "OWNED_CODEX_RECEIPT_PENDING",
              message: "Delivery awaits a Codex receipt",
            },
    };
  }

  private async settleDelivery(
    session: OwnedSession,
    permit: PilotPermit,
    signal: AbortSignal,
    result: DriverDeliveryResult,
  ): Promise<void> {
    const base = { v, ...permitIdentity(permit) } as const;
    let request: DeliverySettleRequest | DeliveryResolutionRequest;
    if (result.state === "delivered") {
      const record = await this.receiptJournal?.find(
        permit.session,
        session.getCheckpoint(),
        permit.delivery_id,
        signal,
      );
      if (!record)
        throw new Error("Owned Codex receipt is absent from the journal");
      request = {
        ...base,
        outcome: "applied",
        resolution_evidence: JSON.stringify(record),
      } satisfies DeliveryResolutionRequest;
    } else {
      const detail = result.failure.message;
      request =
        result.state === "ambiguous"
          ? { ...base, outcome: "in_doubt", detail }
          : {
              ...base,
              outcome: "failed",
              retryable: result.failure.retryable === true,
              detail,
            };
    }
    const reply = await readEdge(
      this.fetch,
      signal,
      "delivery.settle",
      request,
      parseDeliverySettleResponse,
    );
    if (reply.status !== "recorded" && reply.status !== "duplicate")
      throw new Error(
        `Owned Codex settlement was not confirmed: ${reply.status}`,
      );
    if (result.state !== "ambiguous") {
      this.appendedReceipts.delete(permit.delivery_id);
      if (result.state === "delivered")
        await this.forgetReceipt(
          permit.session,
          session.getCheckpoint(),
          permit.delivery_id,
          signal,
        );
      await this.clearImages(permit.attempt_id);
    }
  }
}
