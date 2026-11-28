import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import type { DeliveryFacade, ReceiptJournal } from "@codecast/delivery";
import type { EdgeBlobResult } from "@codecast/edge-supervisor";
import {
  EDGE_PROTOCOL_VERSION as v,
  parseDeliverySettleResponse,
  parseDeliveryStartResponse,
  parsePermitsNextResponse,
  type CanonicalEvent,
  type EdgeParseResult,
  type PermitsNextRequest,
  type PermitsNextResponse,
} from "@codecast/edge-contract";
import type {
  DeliveryReceiptJournal,
  OwnedSession,
} from "@codecast/provider-contract";
import { makeOwnedProviderBridge } from "./codex-pilot-provider-bridge.js";
import type { ExecutionCoordinator } from "./coordinator.js";

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

export class CodexPilotLeaseLost extends Error {}

const HELD_WITHOUT_RECEIPT = "owned_codex_receipt_pending";
const STALE_SETTLE_LIMIT = 5;
const STALE_SETTLE_BASE_MS = 2_000;
const STALE_SETTLE_MAX_MS = 60_000;

type ActiveContext = {
  readonly binding: ReadyBinding;
  readonly coordinator: ExecutionCoordinator;
  readonly session: OwnedSession;
  readonly claim: ClaimGrant;
  readonly prepareText: (text: string) => Promise<string>;
};

export class CodexPilotDelivery {
  receiptJournal?: DeliveryReceiptJournal;
  private readonly appendedReceipts = new Set<string>();
  private readonly images = new Map<string, string>();
  private activeTurn: string | null = null;
  private pendingStarter?: PilotPermit["sender"];
  private headDeliveryId: string | null = null;
  private service?: DeliveryFacade;
  private serviceInit?: Promise<DeliveryFacade>;
  private serviceGeneration = 0;
  private context?: ActiveContext;
  private staleSettle?: { readonly attemptId: string; readonly count: number };

  constructor(
    private readonly fetch: FetchEdge,
    private readonly log: (message: string) => void,
  ) {}

  retryDelayMs(): number | undefined {
    if (!this.staleSettle) return undefined;
    return Math.min(
      STALE_SETTLE_BASE_MS * 2 ** (this.staleSettle.count - 1),
      STALE_SETTLE_MAX_MS,
    );
  }

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

  private activeContext(): ActiveContext {
    if (!this.context)
      throw new Error("Owned Codex delivery has no active session");
    return this.context;
  }

  async clearImages(attemptId?: string): Promise<void> {
    if (attemptId === undefined) {
      const init = this.serviceInit;
      this.service = undefined;
      this.serviceInit = undefined;
      this.serviceGeneration += 1;
      const current = await init?.catch(() => undefined);
      await current?.dispose().catch(() => {});
      if (this.service === current) this.service = undefined;
      this.context = undefined;
      this.staleSettle = undefined;
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
      if (delivery_id === this.headDeliveryId) {
        this.appendedReceipts.add(delivery_id);
        const receipt = await this.receiptJournal?.find(
          event.session,
          session.getCheckpoint(),
          delivery_id,
          signal,
        );
        if (receipt && this.service) {
          await this.service
            .publish(
              {
                kind: "provider.receipt",
                session: event.session,
                run: event.run,
                delivery_id: receipt.delivery_id,
                provider_item_id: receipt.provider_item_id,
                turn: receipt.turn,
              },
              signal,
            )
            .catch(() => {});
        }
      } else {
        await this.forgetReceipt(
          event.session,
          session.getCheckpoint(),
          delivery_id,
          signal,
        );
      }
    }
    if (event.kind === "turn.started") this.activeTurn = event.turn;
    if (event.kind === "turn.ended" && this.activeTurn === event.turn)
      this.activeTurn = null;
  }

  attributeTurnStart(event: CanonicalEvent): CanonicalEvent {
    if (event.kind !== "turn.started" || !this.pendingStarter) return event;
    const starter = this.pendingStarter;
    this.pendingStarter = undefined;
    return { ...event, body: { ...event.body, starter } };
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
      throw new CodexPilotLeaseLost("Owned Codex delivery lease is stale");
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
    if (next.status === "takeover_fence")
      throw new Error("Owned Codex pilot cannot acknowledge a takeover fence");
    this.headDeliveryId = next.delivery_id;
    return next;
  }

  private async ensureService(): Promise<DeliveryFacade> {
    if (this.service) return this.service;
    if (this.serviceInit) return this.serviceInit;
    const generation = ++this.serviceGeneration;
    const init: Promise<DeliveryFacade> = (async () => {
      const { createDeliveryService } = await import("@codecast/delivery");
      const checkpoint = () => this.context?.session.getCheckpoint();
      const receipts: ReceiptJournal = {
        find: async (sessionId, deliveryId, signal) => {
          const cp = checkpoint();
          if (!cp) return undefined;
          const record = await this.receiptJournal?.find(
            sessionId,
            cp,
            deliveryId,
            signal,
          );
          if (record) {
            if (record.delivery_id !== deliveryId) {
              throw new Error(
                "Owned Codex receipt does not match the delivery",
              );
            }
            return {
              delivery_id: record.delivery_id,
              provider_item_id: record.provider_item_id,
              turn: record.turn,
            };
          }
          return undefined;
        },
        record: async (sessionId, receipt, signal) => {
          const cp = checkpoint();
          if (!cp || !this.receiptJournal) return;
          const existing = await this.receiptJournal.find(
            sessionId,
            cp,
            receipt.delivery_id,
            signal,
          );
          if (existing) return;
          await this.receiptJournal.record(sessionId, cp, receipt, signal);
        },
        forget: async (sessionId, deliveryId, signal) => {
          const cp = checkpoint();
          if (!cp) return;
          this.appendedReceipts.delete(deliveryId);
          await this.forgetReceipt(sessionId, cp, deliveryId, signal);
        },
      };

      const facade = createDeliveryService({
        log: this.log,
        receiptJournal: receipts,
        allowTakeover: false,
        runningTurn: () => this.activeTurn,
        canSendNew: (permit) => {
          const turn = permit.intent === "queue" ? null : permit.expected?.turn;
          return turn !== undefined && turn === this.activeTurn;
        },
        prepareText: async (text) =>
          this.context ? this.context.prepareText(text) : text,
        saveBlob: async (permit, index, contentType, bytes) => {
          const extension = contentType.match(
            /^image\/(jpeg|png|webp|gif|heic|heif)$/,
          )?.[1];
          if (!extension)
            throw new Error("Unsupported delivery image content type");
          let directory = this.images.get(permit.attempt_id);
          if (!directory) {
            directory = await mkdtemp(join(tmpdir(), "owned-codex-image-"));
            this.images.set(permit.attempt_id, directory);
          }
          const filePath = join(directory, `${index}.${extension}`);
          const buffer = Buffer.from(bytes);
          await writeFile(filePath, buffer, { mode: 0o600 });
          const { isHeicImage, heicToJpeg } = await import("../heicImage.js");
          const jpg = join(directory, `${index}.jpg`);
          return isHeicImage(buffer) && (await heicToJpeg(filePath, jpg))
            ? jpg
            : filePath;
        },
        clearArtifacts: async (attemptId) => this.clearImages(attemptId),
        bridge: {
          permitsNext: async (request, signal) => {
            const ctx = this.activeContext();
            const next = await readEdge(
              this.fetch,
              signal,
              "permits.next",
              request,
              parsePermitsNextResponse,
            );
            if (next.status === "error") {
              throw new Error(
                `Owned Codex delivery lookup failed: ${next.code}`,
              );
            }
            if (next.status === "stale") {
              this.headDeliveryId = null;
              return { ok: true, response: next };
            }
            if (next.status === "takeover_fence") {
              return { ok: true, response: next };
            }
            const held = ctx.coordinator.getActiveDelivery(
              ctx.binding.conversationId,
            );
            if (held) {
              if (
                next.status === "permit" &&
                next.attempt_id === held.attemptId &&
                next.state === "started"
              ) {
                if (
                  !this.appendedReceipts.has(next.delivery_id) &&
                  (await receipts.find(next.session, next.delivery_id, signal))
                ) {
                  this.appendedReceipts.add(next.delivery_id);
                }
                if (!this.appendedReceipts.has(next.delivery_id)) {
                  return {
                    ok: false,
                    retryable: true,
                    code: HELD_WITHOUT_RECEIPT,
                  };
                }
              } else {
                await ctx.coordinator.reconcileOwnedDelivery(
                  ctx.binding.conversationId,
                  held.attemptId,
                  async () => {
                    if (
                      next.status === "empty" ||
                      next.delivery_id !== held.deliveryId
                    ) {
                      this.appendedReceipts.delete(held.deliveryId);
                      await this.forgetReceipt(
                        ctx.claim.session,
                        ctx.session.getCheckpoint(),
                        held.deliveryId,
                        signal,
                      );
                    }
                    await this.clearImages(held.attemptId);
                    return "released";
                  },
                );
              }
            }
            if (next.status === "empty") {
              this.headDeliveryId = null;
              return { ok: true, response: next };
            }
            this.headDeliveryId = next.delivery_id;
            return { ok: true, response: next };
          },
          deliveryStart: async (request, signal) => {
            const value = await readEdge(
              this.fetch,
              signal,
              "delivery.start",
              request,
              parseDeliveryStartResponse,
            );
            if (value.status === "error") {
              return {
                ok: false,
                retryable: value.retryable,
                code: value.code,
                ...(value.retry_after_ms === undefined
                  ? {}
                  : { retry_after_ms: value.retry_after_ms }),
              };
            }
            return { ok: true, response: value };
          },
          deliverySettle: async (request, signal) => {
            const ctx = this.activeContext();
            const value = await readEdge(
              this.fetch,
              signal,
              "delivery.settle",
              request,
              parseDeliverySettleResponse,
            );
            if (value.status === "error") {
              return {
                ok: false,
                retryable: value.retryable,
                code: value.code,
                ...(value.retry_after_ms === undefined
                  ? {}
                  : { retry_after_ms: value.retry_after_ms }),
              };
            }
            if (value.status === "stale") {
              return { ok: true, response: value };
            }
            if (value.status !== "recorded" && value.status !== "duplicate") {
              throw new Error(
                `Owned Codex settlement was not confirmed: ${value.status}`,
              );
            }
            if (request.outcome === "applied") {
              const held = ctx.coordinator.getActiveDelivery(
                ctx.binding.conversationId,
              );
              if (held && held.attemptId === request.attempt_id) {
                await ctx.coordinator.reconcileOwnedDelivery(
                  ctx.binding.conversationId,
                  held.attemptId,
                  async () => "applied",
                );
              }
            }
            return { ok: true, response: value };
          },
          blobGet: async (request, signal): Promise<EdgeBlobResult> => {
            const response = await this.fetch("blobs.get", request, signal);
            if (!response.ok) {
              return {
                ok: false,
                retryable: response.status === 429 || response.status >= 500,
                code: `http_${response.status}`,
              };
            }
            const contentType = response.headers.get("Content-Type") ?? "";
            const bytes = new Uint8Array(await response.arrayBuffer());
            return { ok: true, content_type: contentType, bytes };
          },
          ...makeOwnedProviderBridge({
            context: () => this.activeContext(),
            receipts,
            hasAppendedReceipt: (deliveryId) =>
              this.appendedReceipts.has(deliveryId),
            setPendingStarter: (sender) => {
              this.pendingStarter = sender;
            },
          }),
        },
      });
      if (this.serviceGeneration === generation) this.service = facade;
      return facade;
    })();
    this.serviceInit = init;
    return init;
  }

  private async markAmbiguous(
    ctx: ActiveContext,
    attemptId: string,
    deliveryId: string,
    failure: { code: string; message: string },
  ): Promise<void> {
    const { conversationId, runtimeId } = ctx.binding;
    if (ctx.coordinator.getActiveDelivery(conversationId)) return;
    await ctx.coordinator.runDeliveryOperation({
      identity: { conversationId, runtimeId, attemptId, deliveryId },
      signature: JSON.stringify({ ...ctx.claim, attemptId, deliveryId }),
      effect: async () => ({ state: "ambiguous", failure }),
      settle: async () => {},
    });
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
    const service = await this.ensureService();
    const fence: PermitsNextRequest = { v: 1, ...deliveryFence(claim) };
    const ctx: ActiveContext = {
      binding,
      coordinator,
      session,
      claim,
      prepareText,
    };
    this.context = ctx;
    for (let count = 0; count < 1024 && !signal.aborted; count++) {
      let outcome;
      try {
        outcome = await service.deliverNext(fence, { sendNew }, signal);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("takeover_unsupported") ||
            (error as { code?: string }).code === "takeover_unsupported")
        ) {
          throw new Error(
            "Owned Codex pilot cannot acknowledge a takeover fence",
          );
        }
        throw error;
      }

      if (
        outcome.status === "retry_scheduled" &&
        outcome.code === HELD_WITHOUT_RECEIPT
      )
        return false;
      if (outcome.status === "lease_stale" && outcome.stage === "settle") {
        const count =
          this.staleSettle?.attemptId === outcome.attempt_id
            ? this.staleSettle.count + 1
            : 1;
        this.staleSettle = { attemptId: outcome.attempt_id, count };
        if (count >= STALE_SETTLE_LIMIT)
          throw new CodexPilotLeaseLost(
            "Owned Codex settlement stayed stale for one attempt",
          );
      } else {
        this.staleSettle = undefined;
      }
      if (outcome.status === "empty") return true;
      if (outcome.status === "held") return !sendNew;
      if (outcome.status === "lease_stale") {
        if (outcome.stage === "permits") {
          throw new CodexPilotLeaseLost("Owned Codex delivery lease is stale");
        }
        await this.markAmbiguous(ctx, outcome.attempt_id, outcome.delivery_id, {
          code: "DELIVERY_TERMINAL_WRITE_AMBIGUOUS",
          message: "Owned Codex settlement was not confirmed: stale",
        });
        return false;
      }
      if (outcome.status === "in_doubt") {
        await this.markAmbiguous(ctx, outcome.attempt_id, outcome.delivery_id, {
          code: outcome.code,
          message: outcome.message,
        });
        return false;
      }
      if (outcome.status === "failed" && outcome.retryable === false) {
        return false;
      }
      if (outcome.status !== "delivered" && outcome.status !== "duplicate") {
        return false;
      }
    }
    return false;
  }
}
