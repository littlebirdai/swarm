import { useRef } from "react";
import { toast } from "sonner";
import { captureException } from "@sentry/react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { dispatchRefusalReason } from "../lib/dispatch-binding";
import { useInboxStore } from "../store/inboxStore";

// "Set session model didn't go through — not authorized". The command name
// rides convCommand's args; the reason is the last server refusal in the
// (possibly nested) error message, minus stack-frame and client-suffix noise.
function describeDispatchFailure(f: {
  action: string;
  args: unknown;
  message: string;
}): string {
  const command =
    f.action === "convCommand" && Array.isArray(f.args)
      ? String(f.args[1])
      : f.action;
  const label = command
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
  const friendly = dispatchRefusalReason(f.message);
  return `${label} didn't go through — ${friendly}`;
}

// Turns a permanent dispatch rejection (recorded by useEnsureDispatch) into a
// visible toast. Lives here rather than in the shared hook because sonner is
// DOM-only and the hook is also bundled by the mobile app.
export function DispatchFailureToast() {
  const failure = useInboxStore((s) => s.lastDispatchFailure);
  const lastShownAt = useRef(0);
  useWatchEffect(() => {
    if (!failure || failure.at === lastShownAt.current) return;
    lastShownAt.current = failure.at;
    const text = describeDispatchFailure(failure);
    toast.error(text);
    // The server's reason reaches no log it can be read back from later, so
    // record it. The action name only: args can carry what the person typed.
    captureException(new Error(text), {
      tags: { source: "dispatch-failure", dispatch_action: failure.action },
    });
  }, [failure]);
  return null;
}
