import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useForcedMoveOptions } from "../../hooks/use-forced-move-options";
import { dispatchRefusalReason } from "../../lib/dispatchRefusal";
import {
  DISPATCH_REFUSED,
  latestSessionCommand,
  newRequestId,
  settleSessionCommand,
} from "../../lib/sessionCommands";
import { useInboxStore } from "../../store/inboxStore";
import { isParkedDispatchError } from "../../store/mutativeMiddleware";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { Button } from "../ui/button";

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
  const submitting = useRef(false);
  const failure =
    request?.result === DISPATCH_REFUSED && request.error
      ? dispatchRefusalReason(request.error)
      : null;
  const requested = options?.requestedDestination;
  const pending =
    request?.source_epoch === options?.epoch && request?.executed_at === null;
  useWatchEffect(() => {
    if (requested && pending && request)
      settleSessionCommand(request._id, { result: "requested" });
  }, [requested, pending, request]);
  if (requested)
    return (
      <div
        className="px-4 py-1.5 text-[12px] text-sol-text-muted"
        role="status"
      >
        Move to {requested} requested
      </div>
    );
  if (!options || now < options.offlineAfter)
    return failure ? (
      <div role="alert" className="px-4 py-1.5 text-[12px] text-sol-red">
        {failure}
      </div>
    ) : null;
  const target = options.destinations.find((d) => d.id === selected);

  const confirm = async () => {
    if (!target || submitting.current) return;
    submitting.current = true;
    setReviewing(false);
    const requestId = newRequestId();
    try {
      await useInboxStore
        .getState()
        .forceSessionMove(
          requestId,
          conversationId,
          options.epoch,
          target.id,
          target.label,
          true,
        );
      settleSessionCommand(requestId, { result: "requested" });
    } catch (error) {
      if (!isParkedDispatchError(error)) {
        const data = (error as { data?: unknown } | null)?.data;
        settleSessionCommand(requestId, {
          result: DISPATCH_REFUSED,
          error: dispatchRefusalReason(
            typeof data === "string" ? data : String(error),
          ),
        });
      }
    } finally {
      submitting.current = false;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 text-[12px] text-sol-text-muted">
      <span>{options.sourceLabel} is offline</span>
      {options.destinations.length > 0 && (
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
      )}
      {failure && (
        <span role="alert" className="text-sol-red">
          {failure}
        </span>
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
