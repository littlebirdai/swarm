import { useRef, useState } from "react";
import {
  ComposerSendButton,
  ComposerShell,
  ComposerTextarea,
  ComposerTextRow,
} from "../ComposerShell";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import {
  composerControlModel,
  type ComposerBaton,
  type ComposerControlCommand,
  type ComposerControlFacts,
} from "./composer-control-model";

export function SessionControlComposer({
  facts,
  baton,
  autoFocusInput,
}: {
  facts: ComposerControlFacts;
  baton: ComposerBaton;
  autoFocusInput?: boolean;
}) {
  const view = composerControlModel(facts);
  const [draft, setDraft] = useState("");
  const editVersion = useRef(0);
  const [review, setReview] = useState<Extract<
    ComposerControlCommand,
    { kind: "takeover" }
  > | null>(null);
  const driver = facts.driver;
  const expected = { kind: "turn", turn: facts.turn } as const;
  const canSubmit = !!draft.trim() && !view.submitting;
  const canConfirm =
    view.takeover === "takeover" &&
    review?.driverId === driver?.id &&
    review?.expected.turn === facts.turn;

  async function submit(queue = false) {
    const text = draft.trim();
    if (!text || view.submitting || !view.send) return;
    const version = editVersion.current;
    const command =
      queue || view.send === "queue"
        ? ({ kind: "queue", text } as const)
        : ({ kind: "send", text, expected } as const);
    if (
      (await baton.run(command)) === "accepted" &&
      version === editVersion.current
    )
      setDraft("");
  }

  return (
    <ComposerShell
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      fieldTop={
        <div
          role="group"
          aria-label="Session control"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-meta text-sol-text-muted"
        >
          <span role="status">
            {view.driver ? `Driving · ${view.driver}` : "No driver"}
          </span>
          {view.takeoverStatus && (
            <span role="status">{view.takeoverStatus}</span>
          )}
          {view.sendStatus && <span role="status">{view.sendStatus}</span>}
          {view.takeover === "takeover" && driver && (
            <button
              type="button"
              aria-haspopup="dialog"
              className="ml-auto font-medium text-sol-orange"
              onClick={() =>
                setReview({ kind: "takeover", driverId: driver.id, expected })
              }
            >
              Take over
            </button>
          )}
          {view.takeover === "cancel" && (
            <button
              type="button"
              className="ml-auto hover:text-sol-text"
              onClick={() => void baton.run({ kind: "cancel-takeover" })}
            >
              Cancel takeover
            </button>
          )}
        </div>
      }
      after={
        review && (
          <SwitchReview
            ledger={{
              name: "Take over",
              subject: facts.driver?.name ?? "Session control",
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
              void baton.run(review);
            }}
          />
        )
      }
    >
      <ComposerTextRow
        send={
          view.send ? (
            <ComposerSendButton
              canSubmit={canSubmit}
              label={view.send === "queue" ? "Queue" : undefined}
              tip={(button, words) => (
                <ShortcutTooltip label={words} accel="enter" side="top">
                  {button}
                </ShortcutTooltip>
              )}
            />
          ) : (
            <button
              type="button"
              disabled={view.request === "requested"}
              className="h-8 rounded-full border border-sol-cyan/30 px-3 text-xs font-medium text-sol-cyan disabled:opacity-50"
              onClick={() => void baton.run({ kind: "ask" })}
            >
              {view.request === "requested"
                ? "Drive requested"
                : "Ask to drive"}
            </button>
          )
        }
      >
        <ComposerTextarea
          aria-label="Message"
          data-chat-input
          autoFocus={autoFocusInput}
          value={draft}
          onChange={(event) => {
            editVersion.current += 1;
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            const { key, keyCode, isComposing } = event.nativeEvent;
            if (
              key !== "Enter" ||
              event.shiftKey ||
              event.altKey ||
              isComposing ||
              keyCode === 229 ||
              !view.send
            )
              return;
            event.preventDefault();
            void submit(event.metaKey || event.ctrlKey);
          }}
        />
      </ComposerTextRow>
    </ComposerShell>
  );
}
