import type {
  DeliveryReceiptJournal,
  InDoubt,
  ProviderIdentity,
  ProviderOffer,
  Refused,
  SessionScope,
  Unsupported,
} from "@codecast/provider-contract";

export interface RawProviderFrame {
  readonly session: SessionScope["session"];
  readonly run: SessionScope["run"];
  readonly line: string;
  readonly disposition: "decoded" | "replay" | "unknown";
  readonly base64Fragment?: { readonly index: number; readonly last: boolean };
}

export interface ProviderAdapterOptions {
  readonly provider: ProviderIdentity;
  readonly command?: readonly [string, ...string[]];
  readonly receiptJournal?: DeliveryReceiptJournal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly retainRaw: (
    frame: RawProviderFrame,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly onStderr?: (text: string) => void;
}

export function providerOffer({
  provider,
  receiptJournal,
}: ProviderAdapterOptions): ProviderOffer {
  return {
    ...provider,
    capabilities:
      process.platform === "win32"
        ? []
        : provider.agent === "grok" && provider.version === "1.0.13"
          ? ["own", "interrupt", "prompts", "resume"]
          : (provider.agent === "codex" && provider.version === "0.153.4") ||
              (provider.agent === "claude" && provider.version === "2.1.319")
            ? [
                "own",
                "steer-mid-turn",
                "interrupt",
                "prompts",
                "resume",
                ...(provider.agent === "codex" && receiptJournal
                  ? ["receipts" as const]
                  : []),
              ]
            : [],
  };
}

export function unsupported(requires: Unsupported["requires"]): Unsupported {
  return { status: "unsupported", requires };
}

export function refused(code: string, message: string): Refused {
  return { status: "refused", code, message };
}

export function inDoubt<Reason extends InDoubt["reason"]>(
  reason: Reason,
  code: string,
  message: string,
): InDoubt & { reason: Reason } {
  return { status: "in-doubt", reason, code, message };
}

export const closed = { status: "closed" } as const;
