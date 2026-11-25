"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";

const RENEW_MS = 20_000;
const STALE_MS = 12_000;
const actionClass =
  "rounded border border-sol-border px-2 py-0.5 hover:text-sol-text";

export function TeamTerminal({
  conversationId,
}: {
  conversationId: Id<"conversations">;
}) {
  const args = { conversation_id: conversationId };
  const { data: status } = useQueryNoThrow(api.terminalWatch.status, args);
  if (status?.role === "owner" && (status.available || status.enabled)) {
    return (
      <TeamTerminalOwner
        conversationId={conversationId}
        enabled={status.enabled}
      />
    );
  }
  if (status?.role === "viewer") {
    return (
      <TeamTerminalViewer
        key={status.share}
        conversationId={conversationId}
        share={status.share}
      />
    );
  }
  return null;
}

function TeamTerminalOwner({
  conversationId,
  enabled,
}: {
  conversationId: Id<"conversations">;
  enabled: boolean;
}) {
  const args = { conversation_id: conversationId };
  const setSharing = useMutation(api.terminalWatch.setSharing);
  const stopViewer = useMutation(api.terminalWatch.stopViewer);
  const { data: watchers } = useQueryNoThrow(
    api.terminalWatch.watchers,
    enabled ? args : "skip",
  );
  const liveWatchers = (now: number) =>
    watchers?.filter((watcher) => watcher.expires_at > now) ?? [];
  const now = useNowWhen(
    (time) =>
      liveWatchers(time)
        .map((watcher) => watcher.user_id)
        .join(","),
    1_000,
  );

  const setEnabled = async (on: boolean) => {
    try {
      if (await setSharing({ ...args, enabled: on })) return;
    } catch {}
    toast.error("Could not change terminal sharing");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-sol-border/30 px-3 py-1 text-meta text-sol-text-muted">
      <ConsequentialSwitch
        on={enabled}
        ledger={{
          name: "Terminal sharing",
          subject: "This session",
          figures: [],
          rows: [
            { k: "Viewers", v: "Teammates who can read this session" },
            { k: "Access", v: "Read-only" },
            { k: "Screen", v: "Redacted" },
          ],
          stop: "Stop sharing",
          confirm: "Share terminal",
        }}
        onTurnOn={() => void setEnabled(true)}
        onTurnOff={() => void setEnabled(false)}
        trigger={({ on, press, reviewing }) => (
          <button
            type="button"
            className={actionClass}
            onClick={press}
            aria-haspopup={on ? undefined : "dialog"}
            aria-expanded={on ? undefined : reviewing}
          >
            {on ? "Stop sharing terminal" : "Share terminal…"}
          </button>
        )}
      />
      {enabled && (
        <ul aria-label="Terminal viewers" className="flex flex-wrap gap-2">
          {liveWatchers(now).map((watcher) => (
            <li
              key={watcher.user_id}
              className="inline-flex items-center gap-1"
            >
              <span>{watcher.name}</span>
              <button
                type="button"
                className={actionClass}
                aria-label={`Stop ${watcher.name} watching`}
                onClick={() => {
                  void stopViewer({ ...args, viewer: watcher.user_id }).then(
                    (ok) => {
                      if (!ok) toast.error("Could not stop viewer");
                    },
                    () => toast.error("Could not stop viewer"),
                  );
                }}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ViewerProps = {
  conversationId: Id<"conversations">;
  share: Id<"terminal_watch_shares">;
};

function TeamTerminalViewer({ conversationId, share }: ViewerProps) {
  const [watching, setWatching] = useState(false);
  const [joining, setJoining] = useState(false);
  const watch = useMutation(api.terminalWatch.watch);
  const args = { conversation_id: conversationId, share };

  return (
    <div className="border-b border-sol-border/30 text-meta text-sol-text-muted">
      <div className="flex items-center gap-2 px-3 py-1">
        {watching && <span>Terminal · Read-only</span>}
        <button
          type="button"
          className={actionClass}
          disabled={joining}
          onClick={() => {
            if (watching) {
              setWatching(false);
              return;
            }
            setJoining(true);
            void watch({ ...args, renew: false })
              .then(
                (ok) => {
                  setWatching(ok);
                  if (!ok) toast.error("Terminal watching is unavailable");
                },
                () => toast.error("Could not open terminal"),
              )
              .finally(() => setJoining(false));
          }}
        >
          {watching ? "Close terminal view" : "Watch terminal"}
        </button>
      </div>
      {watching && (
        <TeamTerminalScreen
          conversationId={conversationId}
          share={share}
          stop={setWatching}
        />
      )}
    </div>
  );
}

function TeamTerminalScreen({
  conversationId,
  share,
  stop,
}: ViewerProps & { stop: (watching: boolean) => void }) {
  const watch = useMutation(api.terminalWatch.watch);
  const { data: screen, error } = useQueryNoThrow(api.terminalWatch.screen, {
    conversation_id: conversationId,
    share,
  });
  const status = (time: number) => {
    if (error || screen === null || (screen && screen.expires_at <= time))
      return "ended";
    if (!screen?.seen_at) return "connecting";
    return screen.seen_at + STALE_MS <= time ? "paused" : "live";
  };
  const now = useNowWhen(status, 1_000);
  const state = status(now);
  const ended = state === "ended";

  useWatchEffect(() => {
    if (ended) {
      stop(false);
      return;
    }
    let active = true;
    const timer = setInterval(() => {
      void watch({ conversation_id: conversationId, share, renew: true })
        .then((ok) => {
          if (active && !ok) stop(false);
        })
        .catch(() => {});
    }, RENEW_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [conversationId, share, ended, stop, watch]);

  if (state === "ended") return null;
  if (state !== "live") {
    return (
      <div role="status" className="px-3 py-3">
        {state === "connecting" ? "Connecting…" : "Terminal paused"}
      </div>
    );
  }
  return (
    <pre
      aria-label="Read-only terminal screen"
      className="max-h-72 overflow-auto whitespace-pre bg-sol-bg px-3 py-2 font-mono text-sol-text"
    >
      {screen?.text}
    </pre>
  );
}
