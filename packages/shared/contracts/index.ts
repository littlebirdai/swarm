// Cross-runtime contract enums: pure 'as const' arrays + derived types that are
// the single source of truth shared by the Convex backend, the Node daemon, and
// the browser. PURE isomorphic data only — no Node or DOM APIs — so the Convex
// runtime can import them.
// Which vendors hold a BAA, so a regulated team's data reaches only those.
// The fleet comparison — one row per capability, one cell per machine. Here for
// the same reason: the CLI, the browser and Convex all render this grid, and
// while it lived in the CLI the other two could only reimplement it.
// The cross-entity review queue row — one shape for "what is waiting on a
// human", fed by comment threads, page comments, and workflow gates alike.
// Not re-exported here, imported by path: orgProposal (the fenced block
// `cast org init` decisions carry). It sits off the CLI boot graph on purpose
// (bench/bootGraph.guard.test.ts): the barrel is on every entry's static
// graph, so a re-export here is paid by `cast --help`.

// Codecast for outside agents (MCP): the address, the read tools, what a connection can do.
