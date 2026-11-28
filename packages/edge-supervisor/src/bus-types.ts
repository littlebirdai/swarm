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
} from "@codecast/edge-contract";

export type DeliveryReceipt = {
  readonly delivery_id: string;
  readonly provider_item_id: string;
  readonly turn: string;
};

export type ProviderDeliverInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "local-image"; readonly path: string };

export type ProviderDeliverOutcome =
  | { readonly status: "delivered"; readonly receipt: DeliveryReceipt }
  | { readonly status: "duplicate"; readonly receipt: DeliveryReceipt }
  | {
      readonly status: "in_doubt";
      readonly reason: "best-effort" | "unknown";
      readonly code: string;
      readonly message: string;
      readonly retry_after_ms?: number;
    }
  | {
      readonly status: "failed";
      readonly retryable: boolean;
      readonly code: string;
      readonly message: string;
      readonly retry_after_ms?: number;
    }
  | {
      readonly status: "stale";
      readonly observed: {
        readonly kind: "turn";
        readonly turn: string | null;
      };
    };

export type ProviderRecoverOutcome =
  | { readonly status: "delivered"; readonly receipt: DeliveryReceipt }
  | {
      readonly status: "failed";
      readonly retryable: false;
      readonly resolution_evidence: string;
    }
  | {
      readonly status: "in_doubt";
      readonly code: string;
      readonly message: string;
      readonly retry_after_ms?: number;
    }
  | { readonly status: "busy"; readonly retry_after_ms: number };

export type EdgeBusResult<T> =
  | { readonly ok: true; readonly response: T }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly code: string;
      readonly retry_after_ms?: number;
    };

export type EdgeBlobResult =
  | {
      readonly ok: true;
      readonly content_type: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly code: string;
      readonly retry_after_ms?: number;
    };

export type BusMessage =
  | {
      readonly kind: "delivery.wake";
      readonly session: string;
      readonly run: number;
      readonly fencing_token: string;
      readonly send_new?: boolean;
    }
  | {
      readonly kind: "delivery.stop";
      readonly session: string;
      readonly run?: number;
    }
  | {
      readonly kind: "delivery.settled";
      readonly session: string;
      readonly run: number;
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly outcome:
        | "delivered"
        | "duplicate"
        | "in_doubt"
        | "failed"
        | "stale";
      readonly retry_after_ms?: number;
    }
  | {
      readonly kind: "edge.permits.next";
      readonly request_id: string;
      readonly request: PermitsNextRequest;
    }
  | ({
      readonly kind: "edge.permits.next.result";
      readonly request_id: string;
    } & EdgeBusResult<Exclude<PermitsNextResponse, EdgeErrorResponse>>)
  | {
      readonly kind: "edge.delivery.start";
      readonly request_id: string;
      readonly request: DeliveryStartRequest;
    }
  | ({
      readonly kind: "edge.delivery.start.result";
      readonly request_id: string;
    } & EdgeBusResult<Exclude<DeliveryStartResponse, EdgeErrorResponse>>)
  | {
      readonly kind: "edge.delivery.settle";
      readonly request_id: string;
      readonly request: DeliverySettleRequest | DeliveryResolutionRequest;
    }
  | ({
      readonly kind: "edge.delivery.settle.result";
      readonly request_id: string;
    } & EdgeBusResult<Exclude<DeliverySettleResponse, EdgeErrorResponse>>)
  | {
      readonly kind: "edge.takeover.ack";
      readonly request_id: string;
      readonly request: TakeoverAckRequest;
    }
  | ({
      readonly kind: "edge.takeover.ack.result";
      readonly request_id: string;
    } & EdgeBusResult<Exclude<TakeoverAckResponse, EdgeErrorResponse>>)
  | {
      readonly kind: "edge.blob.get";
      readonly request_id: string;
      readonly request: BlobsGetRequest;
    }
  | ({
      readonly kind: "edge.blob.get.result";
      readonly request_id: string;
    } & EdgeBlobResult)
  | {
      readonly kind: "provider.deliver";
      readonly request_id: string;
      readonly session: string;
      readonly run: number;
      readonly fencing_token: string;
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly seq: number;
      readonly intent: "steer" | "queue";
      readonly sender: {
        readonly kind: "person" | "agent";
        readonly id: string;
      };
      readonly expected?: { readonly kind: "turn"; readonly turn: string };
      readonly baton_token?: number | null;
      readonly input: readonly ProviderDeliverInput[];
    }
  | {
      readonly kind: "provider.deliver.cancel";
      readonly request_id: string;
    }
  | {
      readonly kind: "provider.deliver.result";
      readonly request_id: string;
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly outcome: ProviderDeliverOutcome;
    }
  | {
      readonly kind: "provider.recover";
      readonly request_id: string;
      readonly session: string;
      readonly run: number;
      readonly fencing_token: string;
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly expected?: { readonly kind: "turn"; readonly turn: string };
      readonly baton_token?: number | null;
    }
  | {
      readonly kind: "provider.recover.result";
      readonly request_id: string;
      readonly delivery_id: string;
      readonly attempt_id: string;
      readonly outcome: ProviderRecoverOutcome;
    }
  | {
      readonly kind: "provider.receipt";
      readonly session: string;
      readonly run: number;
      readonly delivery_id: string;
      readonly provider_item_id: string;
      readonly turn: string;
    };

export type BusMessageKind = BusMessage["kind"];

export type BusMessageOf<K extends BusMessageKind> = Extract<
  BusMessage,
  { readonly kind: K }
>;
