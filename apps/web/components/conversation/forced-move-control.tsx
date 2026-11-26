import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useForcedMoveOptions } from "../../hooks/use-forced-move-options";
import {
  DISPATCH_REFUSED,
  latestSessionCommand,
  newRequestId,
  recordSessionCommandDispatchError,
  settleSessionCommand,
} from "../../lib/session-commands";
import { useInboxStore } from "../../store/inboxStore";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { Button } from "../ui/button";

async function requestForcedMove(
  conversationId: string,
  epoch: number,
  target: { id: string; label: string },
) {
  const requestId = newRequestId();
  try {
    await useInboxStore
      .getState()
      .forceSessionMove(
        requestId,
        conversationId,
        epoch,
        target.id,
        target.label,
        true,
      );
    settleSessionCommand(requestId, { result: "requested" });
  } catch (error) {
    recordSessionCommandDispatchError(requestId, error);
  }
}

export function ForcedMoveControl({
  conversationId,
}: {
  conversationId: string;
}) {
  const options = useForcedMoveOptions(conversationId);
  const request = useInboxStore((s) =>
    latestSessionCommand(
      s.sessionCommands,
      (row) =>
        row.kind === "force-move" && row.conversation_id === conversationId,
    ),
  );
  const now = useCoarseNow(15_000);
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const submitting = useRef(false);
  const requestEpoch = request?.source_epoch;
  const optionsEpoch = options?.epoch;
  const currentRequest = requestEpoch === optionsEpoch ? request : undefined;
  const offline = options !== undefined && now >= options.offlineAfter;
  const result = currentRequest?.result;
  const refusal =
    result === DISPATCH_REFUSED &&
    currentRequest &&
    currentRequest._id !== dismissed
      ? currentRequest
      : undefined;
  const echoedDestination = options?.requestedDestination;
  const requestLabel = currentRequest?.to_label;
  const requested =
    echoedDestination ?? (result === "requested" ? requestLabel : undefined);
  const pending = currentRequest?.executed_at === null;
  useWatchEffect(() => {
    if (echoedDestination && pending && currentRequest)
      settleSessionCommand(currentRequest._id, { result: "requested" });
  }, [echoedDestination, pending, currentRequest]);
  if (requested)
    return (
      <div
        className="px-4 py-1.5 text-[12px] text-sol-text-muted"
        role="status"
      >
        Move to {requested} requested
      </div>
    );
  if (!options || !offline || (!options.destinations.length && !refusal))
    return null;
  const target = options.destinations.find((d) => d.id === selected);

  const confirm = () => {
    if (!target || submitting.current) return;
    submitting.current = true;
    setReviewing(false);
    void requestForcedMove(conversationId, options.epoch, target).finally(
      () => {
        submitting.current = false;
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 text-[12px] text-sol-text-muted">
      {options.destinations.length > 0 && (
        <>
          <span>{options.sourceLabel} is offline</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setSelected("");
              setReviewing(true);
            }}
          >
            {pending ? "Requesting move…" : "Move to another device"}
          </Button>
        </>
      )}
      {refusal && (
        <>
          <span role="alert" className="text-sol-red">
            {refusal.error}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDismissed(refusal._id)}
          >
            Dismiss
          </Button>
        </>
      )}
      {reviewing && (
        <SwitchReview
          ledger={{
            name: "Force device move",
            subject: "This session",
            shift: null,
            figures: [],
            rows: [
              { k: "Destination", v: target?.label ?? "Choose a device" },
              {
                k: options.sourceLabel,
                v: "Permanently cut off from this session",
                tone: "warn",
              },
              {
                k: "Work in progress",
                v: "May be lost on the old computer",
                tone: "warn",
              },
              {
                k: "In-flight messages",
                v: "Delivery becomes uncertain",
                tone: "warn",
              },
              { k: "Undo", v: "This cannot be undone", tone: "warn" },
            ],
            confirm: "Force move",
            keep: "Cancel",
            blocked: target ? undefined : "Choose a destination device",
          }}
          onClose={() => setReviewing(false)}
          onConfirm={() => void confirm()}
        >
          <label className="flex items-center gap-3 border-b border-sol-border/60 px-5 py-3 text-[12.5px]">
            Destination device
            <select
              className="min-w-0 rounded border border-sol-border bg-sol-bg-alt px-2 py-1"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose a device</option>
              {options.destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </SwitchReview>
      )}
    </div>
  );
}
