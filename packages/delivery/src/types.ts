import type {
  BlobsGetRequest,
  DeliveryResolutionRequest,
  DeliverySettleRequest,
  DeliverySettleResponse,
  DeliveryStartRequest,
  DeliveryStartResponse,
  EdgeErrorResponse,
  PermitsNextRequest,
  PermitsNextResponse,
  TakeoverAckRequest,
  TakeoverAckResponse,
  TakeoverFence,
} from "@codecast/edge-contract";
import type {
  BusMessage,
  BusMessageOf,
  HandlerLimits,
  DeliveryReceipt,
  EdgeBlobResult,
  EdgeBusResult,
  ProviderDeliverOutcome,
  ProviderRecoverOutcome,
} from "@codecast/edge-supervisor";

export type { DeliveryReceipt };

export type DeliveryPermit = Extract<PermitsNextResponse, { status: "permit" }>;

export type SteerPermit = Extract<DeliveryPermit, { intent: "steer" }>;

export type DeliverySteerHandover = {
  readonly v: 1;
  readonly session: string;
  readonly run: number;
  readonly fencing_token: string;
  readonly delivery_id: string;
  readonly attempt_id: string;
  readonly seq: number;
  readonly intent: "steer";
  readonly sender: SteerPermit["sender"];
  readonly expected: SteerPermit["expected"];
  readonly baton_token: SteerPermit["baton_token"];
};

export type DeliverySteerJournal = {
  readonly fences: readonly (TakeoverFence & {
    readonly acknowledged?: true;
  })[];
  readonly handovers: readonly DeliverySteerHandover[];
};

export interface ReceiptJournal {
  find(
    session: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<DeliveryReceipt | undefined>;
  record(
    session: string,
    receipt: DeliveryReceipt,
    signal: AbortSignal,
  ): Promise<void>;
  forget(
    session: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SteerJournal {
  load(
    scope: Pick<PermitsNextRequest, "session" | "run">,
    signal: AbortSignal,
  ): Promise<DeliverySteerJournal | undefined>;
  save(
    scope: Pick<PermitsNextRequest, "session" | "run">,
    state: DeliverySteerJournal,
    signal: AbortSignal,
  ): Promise<void>;
}

export type SettlementReceiptStatus = Exclude<
  DeliverySettleResponse,
  EdgeErrorResponse
>["status"];

export type TakeoverReceiptStatus = Exclude<
  TakeoverAckResponse,
  EdgeErrorResponse
>["status"];

export type DeliveryStepOutcome =
  | {
      readonly status: "delivered";
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly receipt: DeliveryReceipt;
      readonly receipt_status: SettlementReceiptStatus;
    }
  | {
      readonly status: "duplicate";
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly receipt: DeliveryReceipt;
      readonly receipt_status: SettlementReceiptStatus;
    }
  | {
      readonly status: "in_doubt";
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly code: string;
      readonly message: string;
      readonly retry_after_ms?: number;
      readonly receipt_status?: SettlementReceiptStatus;
    }
  | {
      readonly status: "failed";
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly retryable: boolean;
      readonly code: string;
      readonly message: string;
      readonly retry_after_ms?: number;
      readonly receipt_status?: SettlementReceiptStatus;
    }
  | {
      readonly status: "stale";
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly observed: {
        readonly kind: "turn";
        readonly turn: string | null;
      };
      readonly receipt_status?: SettlementReceiptStatus;
    }
  | {
      readonly status: "rejected";
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly reason: string;
    }
  | {
      readonly status: "takeover";
      readonly receipt: {
        readonly v: 1;
        readonly status: TakeoverReceiptStatus;
      };
    }
  | { readonly status: "pending" }
  | { readonly status: "fenced" }
  | { readonly status: "empty" }
  | { readonly status: "held" }
  | { readonly status: "lease_stale"; readonly stage: "permits" }
  | {
      readonly status: "lease_stale";
      readonly stage: "settle";
      readonly delivery_id: string;
      readonly attempt_id: string;
    }
  | {
      readonly status: "retry_scheduled";
      readonly retryable: boolean;
      readonly code: string;
      readonly retry_after_ms?: number;
    };

export type DeliveryOptions = {
  readonly receiptJournal?: ReceiptJournal;
  readonly steerJournal?: SteerJournal;
  readonly runningTurn?: (
    scope: Pick<PermitsNextRequest, "session" | "run">,
  ) => string | null;
  readonly canSendNew?: (permit: DeliveryPermit) => boolean;
  readonly prepareText?: (
    text: string,
    permit: DeliveryPermit,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly saveBlob?: (
    permit: DeliveryPermit,
    index: number,
    contentType: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly clearArtifacts?: (attemptId: string) => Promise<void>;
  readonly maxPermitsPerDrain?: number;
  readonly baseRetryMs?: number;
  readonly maxRetryMs?: number;
  readonly maxRetryAttempts?: number;
  readonly allowTakeover?: boolean;
  readonly log?: (message: string) => void;
};

export type DeliveryBridge = {
  readonly permitsNext?: (
    request: PermitsNextRequest,
    signal: AbortSignal,
  ) => Promise<EdgeBusResult<Exclude<PermitsNextResponse, EdgeErrorResponse>>>;
  readonly deliveryStart?: (
    request: DeliveryStartRequest,
    signal: AbortSignal,
  ) => Promise<
    EdgeBusResult<Exclude<DeliveryStartResponse, EdgeErrorResponse>>
  >;
  readonly deliverySettle?: (
    request: DeliverySettleRequest | DeliveryResolutionRequest,
    signal: AbortSignal,
  ) => Promise<
    EdgeBusResult<Exclude<DeliverySettleResponse, EdgeErrorResponse>>
  >;
  readonly takeoverAck?: (
    request: TakeoverAckRequest,
    signal: AbortSignal,
  ) => Promise<EdgeBusResult<Exclude<TakeoverAckResponse, EdgeErrorResponse>>>;
  readonly blobGet?: (
    request: BlobsGetRequest,
    signal: AbortSignal,
  ) => Promise<EdgeBlobResult>;
  readonly deliver?: (
    request: BusMessageOf<"provider.deliver">,
    signal: AbortSignal,
  ) => Promise<ProviderDeliverOutcome>;
  readonly recover?: (
    request: BusMessageOf<"provider.recover">,
    signal: AbortSignal,
  ) => Promise<ProviderRecoverOutcome>;
};

export type DeliveryServiceOptions = DeliveryOptions & {
  readonly bridge?: DeliveryBridge;
  readonly bridgeLimits?: HandlerLimits;
};

export type DrainOptions = {
  readonly sendNew?: boolean;
};

export interface DeliveryFacade {
  deliverNext(
    run: PermitsNextRequest,
    options?: DrainOptions,
    signal?: AbortSignal,
  ): Promise<DeliveryStepOutcome>;
  drain(
    run: PermitsNextRequest,
    options?: DrainOptions,
    signal?: AbortSignal,
  ): Promise<DeliveryStepOutcome>;
  publish(message: BusMessage, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
