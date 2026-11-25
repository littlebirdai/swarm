#!/usr/bin/env node
// WebSocket byte meter for the Convex sync socket (sync-log-cargo E8 gate).
//
// Attaches to a page in the cast browser (or any Chrome with --remote-debugging)
// over CDP, listens to Network.webSocketFrameReceived, and attributes each
// Transition's bytes to the query names it updates (learned from the
// ModifyQuerySet/Add messages the client sends). Prints per-query bytes and
// frame counts over the window, so a fat-query retirement can be measured
// before/after instead of asserted.
//
//   node scripts/perf/ws-bytes.mjs --port 62066 --url local.codecast.sh --seconds 60 --reconnect 1
//
// Queries subscribed before the meter attached show as query#<socket>:<id> unless the
// client re-sends its query set: --reconnect 1 drops the socket for two
// seconds (the client re-adds every query on reconnect; the page and its
// sync-host role are untouched); --reload 1 reloads the page instead, which
// releases the sync-host lock — use it only to measure a cold boot.
import { readFile } from "node:fs/promises";
import { createSocketMeter } from "./ws-frame-meter.mjs";
import { socketQueryReport } from "./ws-bytes-report.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : []))
    .filter(Boolean),
);
const PORT = args.port ?? "9222";
const URL_MATCH = args.url ?? "codecast";
const SECONDS = Number(args.seconds ?? 60);
const limit = Number(args.top ?? 10);
if (
  !Number.isFinite(SECONDS) ||
  SECONDS <= 0 ||
  !Number.isSafeInteger(limit) ||
  limit < 1
)
  throw new Error("Use a positive duration and a positive integer for --top");
const readSets = args["read-sets"]
  ? JSON.parse(await readFile(args["read-sets"], "utf8"))
  : {};
if (
  !readSets ||
  typeof readSets !== "object" ||
  Array.isArray(readSets) ||
  Object.values(readSets).some(
    (set) =>
      !Array.isArray(set) || set.some((table) => typeof table !== "string"),
  )
)
  throw new Error(
    "Use a JSON object that maps query names to arrays of read sets",
  );

const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) =>
  r.json(),
);
const page = targets.find(
  (t) => t.type === "page" && t.url.includes(URL_MATCH),
);
if (!page) {
  console.error(
    "no page matching",
    URL_MATCH,
    targets.map((t) => t.url),
  );
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const send = (method, params) =>
  new Promise((res) => {
    const my = ++id;
    const on = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === my) {
        ws.removeEventListener("message", on);
        res(d.result);
      }
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
// A Transition above the socket's frame size ships as TransitionChunk parts
// (transitionId, partNumber, totalParts, chunk); the query attribution below
// needs the reassembled message, so buffer the parts and account the whole
// once the last one lands. The raw bytes still count per frame.
const meter = createSocketMeter();
let measuring = false;
ws.addEventListener("message", (event) =>
  meter.record(JSON.parse(event.data), measuring),
);
await send("Network.enable", {});
if (args.reload === "1") {
  await send("Page.enable", {});
  await send("Page.reload", {});
}
// --reconnect 1: drop the socket for two seconds so the Convex client re-sends
// its whole query set as Add frames (names resolve) WITHOUT reloading — a
// reload releases the sync-host lock and another window takes the global
// feeds, so a post-reload measurement is of a follower, not the host.
if (args.reconnect === "1") {
  const off = (offline) =>
    send("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  await off(true);
  await new Promise((r) => setTimeout(r, 2000));
  await off(false);
}
console.error(
  `measuring ${SECONDS}s on ${page.url}${args.reload === "1" ? " (after reload)" : ""}${args.reconnect === "1" ? " (after reconnect)" : ""}`,
);
measuring = true;
await new Promise((r) => setTimeout(r, SECONDS * 1000));
measuring = false;
const { byQuery, totalBytes: total, frames } = meter.snapshot();
// Names for queries subscribed before the meter attached: ask the page's
// client (dev builds expose window.__convexClient) which function each id
// maps to, and fold the unnamed buckets into the named ones.
const openSocket = meter.openSocket();
if (openSocket !== undefined) {
  const prefix = `query#${openSocket}:`;
  const unnamed = [...byQuery.keys()].filter((name) => name.startsWith(prefix));
  if (unnamed.length) {
    const ids = unnamed.map((name) => Number(name.slice(prefix.length)));
    const result = await send("Runtime.evaluate", {
      expression: `(() => { const c = window.__convexClient; if (!c) return null; const st = c.sync?.state; return JSON.stringify(${JSON.stringify(ids)}.map((id) => { try { return st?.queryPath?.(id) ?? null; } catch { return null; } })); })()`,
      returnByValue: true,
    });
    const paths = result?.result?.value
      ? JSON.parse(result.result.value)
      : null;
    if (paths) {
      unnamed.forEach((name, index) => {
        const path = paths[index];
        if (!path) return;
        const from = byQuery.get(name);
        byQuery.delete(name);
        const prior = byQuery.get(path) ?? { bytes: 0, frames: 0 };
        prior.bytes += from.bytes;
        prior.frames += from.frames;
        byQuery.set(path, prior);
      });
    }
  }
}
if (args.json === "1") {
  console.log(
    JSON.stringify({
      version: 1,
      seconds: SECONDS,
      totalBytes: total,
      frames,
      queries: socketQueryReport(byQuery, readSets, limit),
    }),
  );
} else {
  console.log(
    `\ntotal ${total} bytes in ${frames} frames (${(total / SECONDS).toFixed(0)} B/s)`,
  );
  console.log("query".padEnd(48), "bytes".padStart(10), "updates".padStart(8));
  for (const row of socketQueryReport(byQuery, readSets))
    console.log(
      row.query.padEnd(48),
      String(row.bytes).padStart(10),
      String(row.updates).padStart(8),
    );
}
ws.close();
process.exit(0);
