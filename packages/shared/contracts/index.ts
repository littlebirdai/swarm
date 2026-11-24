// Cross-runtime contract enums: pure 'as const' arrays + derived types that are
// the single source of truth shared by the Convex backend, the Node daemon, and
// the browser. PURE isomorphic data only — no Node or DOM APIs — so the Convex
// runtime can import them.
export * from "./executionBinding";
// The needs-input digest: the window, the wording and the row grouping, shared
// by the Convex fold-up and the web bell so both name the same set.
export * from "./idleDigest";
export * from "./closedSession";
export * from "./taskStats";
export * from "./threadState";
export * from "./apiErrorBanner";
// Cloud placement: the one predicate the web composer and the Convex start
// chokepoint share for "does this launch need a laptop to prepare the host".
export * from "./newSessionDefaults";
export * from "./orgTemplateBind";
export * from "./snippets";
export * from "./featureExplainers";
export * from "./agentSwitch";
export * from "./forkSeed";
// Which vendors hold a BAA, so a regulated team's data reaches only those.
export * from "./stableContext";
export * from "./vaultProtocol";
export * from "./vaultMirror";
export * from "./transcriptChunk";
export * from "./callLinks";
// The row a finished huddle leaves in its chat room or session: one formatter
// for the digest markdown and the <huddle-summary> wire tag, one parser back.
export * from "./huddleDigest";
export * from "./screenRecording";
// Without these two lines every consumer reinvents the capability vocabulary:
// convex copied the constants, the web store reached in by relative path, and
// the web UI and the CLI each declared their own scope and kind unions. Four
// workarounds for one missing export.
export * from "./capabilityResolver";
// The fleet comparison — one row per capability, one cell per machine. Here for
// the same reason: the CLI, the browser and Convex all render this grid, and
// while it lived in the CLI the other two could only reimplement it.
export * from "./sanitizeText";
// Machine-delivered message detection: web/mobile previews and the convex
// send classifier must agree on what a human-typed message is.
export * from "./machineMessages";
export * from "./sessionEscalation";
export * from "./vaultMessages";
export * from "./decisionAnswers";
// The connectable-apps catalog (the /capabilities Apps tab): Convex answers
// connection state in this vocabulary and the web renders it, so both need the
// one definition. Deep paths do not resolve past the exports map — barrel only.
export * from "./appDescriptors";
export * from "./githubAppInstallState";
// The cross-entity review queue row — one shape for "what is waiting on a
// human", fed by comment threads, page comments, and workflow gates alike.
// The inbox projection: the bucket alphabet, the ONE placement function the
// Convex overlay and the CLI inbox both call, the time-flip stamps and the
// order-independent digest every client compares against (sync-convergence C3, C8).
export * from "./inboxProjection";
export * from "./appSurfaces";
export * from "./conversationFields";
export * from "./triggerLifecycle";
// Not re-exported here, imported by path: orgProposal (the fenced block
// `cast org init` decisions carry). It sits off the CLI boot graph on purpose
// (bench/bootGraph.guard.test.ts): the barrel is on every entry's static
// graph, so a re-export here is paid by `cast --help`.

export * from "./unattended";
export * from "./handoffPrompt";
export type { AskResult, SideAnswerRow } from "./sessionAsk";
export { SIDE_ANSWER_EXPIRE_MS, explainAskFailure } from "./sessionAsk";
// Codecast for outside agents (MCP): the address, the read tools, what a connection can do.
