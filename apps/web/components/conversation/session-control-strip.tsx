import { useState } from "react";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import type { ComposerControlCommand } from "./composer-control-model";
import type { ComposerControl } from "./use-composer-control";

export function SessionControlStrip({
  control,
  interrupt,
}: {
  control: ComposerControl;
  interrupt?: () => void;
}) {
  const [review, setReview] = useState<Extract<
    ComposerControlCommand,
    { kind: "takeover" }
  > | null>(null);
  const driver = control.facts.driver;
  const canConfirm =
    control.takeover === "takeover" &&
    review?.driverId === driver?.id &&
    review?.expected.turn === control.expected.turn &&
    !control.takeoverPending;

  return (
    <div
      role="group"
      aria-label="Session control"
      className="pb-1 text-meta text-sol-text-muted"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span role="status">
          {control.driver ? `Driving · ${control.driver}` : "No driver"}
        </span>
        {control.takeoverStatus && (
          <span role="status">{control.takeoverStatus}</span>
        )}
        {control.sendStatus && <span role="status">{control.sendStatus}</span>}
        {control.controlError && (
          <span role="status">
            {control.controlError === "refused"
              ? "Control request refused"
              : "Control request in doubt"}
          </span>
        )}
        {control.request && (
          <button
            type="button"
            disabled={control.request === "requested" || control.askPending}
            className="text-sol-cyan disabled:opacity-50"
            onClick={() => void control.act({ kind: "ask" })}
          >
            {control.request === "requested"
              ? "Drive requested"
              : "Ask to drive"}
          </button>
        )}
        {control.takeover === "takeover" && driver && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={!!review}
            disabled={control.takeoverPending}
            className="font-medium text-sol-orange disabled:opacity-50"
            onClick={() =>
              setReview({
                kind: "takeover",
                driverId: driver.id,
                expected: control.expected,
              })
            }
          >
            Take over
          </button>
        )}
        {control.takeover === "cancel" && (
          <button
            type="button"
            disabled={control.cancelPending}
            onClick={() => void control.act({ kind: "cancel-takeover" })}
          >
            Cancel takeover
          </button>
        )}
        {interrupt && (
          <ShortcutTooltip
            label="Interrupt"
            accel={control.interruptPending ? undefined : "escape"}
            side="top"
          >
            <button
              type="button"
              disabled={control.interruptPending}
              onClick={interrupt}
            >
              Interrupt
            </button>
          </ShortcutTooltip>
        )}
      </div>
      {control.retries.map((retry) => (
        <div
          key={retry.id}
          className="flex items-center gap-2"
          role="group"
          aria-label="Draft to retry"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {retry.payload.text}
          </span>
          {control.canQueue && (
            <button
              type="button"
              disabled={control.submitting}
              onClick={() => void control.queueRetry(retry)}
            >
              Queue
            </button>
          )}
        </div>
      ))}
      {review && (
        <SwitchReview
          ledger={{
            name: "Take over",
            subject: driver?.name ?? "Session control",
            shift: null,
            figures: [],
            rows: [
              { k: "Driver", v: "You" },
              { k: "In-flight steer", v: "Wait for the machine" },
            ],
            confirm: "Confirm takeover",
            keep: "Cancel",
            blocked: canConfirm ? undefined : "Driver or turn changed",
          }}
          onClose={() => setReview(null)}
          onConfirm={() => {
            if (!canConfirm) return;
            setReview(null);
            void control.act(review);
          }}
        />
      )}
    </div>
  );
}
