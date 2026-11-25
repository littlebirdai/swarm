import type { BootPhase } from "./timing-samples";

// True while the boot loader applies the disk cache to the store. Every writer
// skips disk while it is set, or hydration would write back what it just read.
export let _hydrating = false;
const boot = {
  phase: undefined as BootPhase | undefined,
  focusedMessages: false,
  outbox: false,
};

export function setHydrating(v: boolean) {
  _hydrating = v;
  setHydrationReadPhase(v ? "critical" : undefined);
  if (v) {
    boot.focusedMessages = true;
    boot.outbox = true;
  }
}

export function setHydrationReadPhase(next: BootPhase | undefined) {
  boot.phase = next;
}

export function takeBootReadPhase(
  read: "focusedMessages" | "outbox",
): BootPhase | undefined {
  if (!boot[read] || (read === "focusedMessages" && boot.phase !== "critical"))
    return;
  boot[read] = false;
  return read === "focusedMessages" ? "critical" : "deferred";
}
