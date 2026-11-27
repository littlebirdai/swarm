import { ConvexReactClient } from "convex/react";
import { recoveringWebSocket } from "@codecast/network";
import { CodecastAuthRoot } from "@/lib/authRoot";
import { CONVEX_URL } from "@/lib/localAuth";
import { DOCS_SHOTS, docsShotsConvex } from "@/lib/docsShots/flag";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Providers } from "./providers";

const convex: ConvexReactClient = DOCS_SHOTS
  ? docsShotsConvex()
  : (import.meta.hot?.data?.convexClient ??
    new ConvexReactClient(CONVEX_URL, {
      unsavedChangesWarning: false,
      webSocketConstructor: recoveringWebSocket(),
    }));

if (import.meta.hot) {
  import.meta.hot.data.convexClient = convex;
}

// Dev-only introspection, next to `window.__inboxStore`: the perf harness
// (scripts/perf/ws-bytes.mjs) names socket traffic by asking the client which
// query id maps to which function, instead of waiting for Add frames.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as any).__convexClient = convex;
  // Fire any toast from the console to check its face: __toast.success("Saved").
  (window as any).__toast = toast;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <CodecastAuthRoot client={convex}>
      <Providers>{children}</Providers>
    </CodecastAuthRoot>
  );
}
