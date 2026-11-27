import assert from "node:assert/strict";
import type { ReplicationChannel } from "@platform/engine";
import { heapStats } from "bun:jsc";
import { replaceGlobals } from "../test-helpers/globals";

const panel = process.argv[2];
const aliases = {
  palette: "isPaletteWindow",
  people: "isPeopleWindow",
  "call-panel": "isCallPanelWindow",
  "agent-dock": "isAgentDockWindow",
} as const;
assert(panel && Object.hasOwn(aliases, panel), "Pass a desktop panel name");
const role = aliases[panel as keyof typeof aliases];
const { REGISTERED_COLLECTION_KEYS, REPLICATED_STORE_KEYS } =
  await import("../store/clientSyncRegistry");
const { desktopWindowKeys } = await import("../store/desktop-panel-keys");
const { replicationFollowerFor, replicationHostFor } =
  await import("../store/sync-replication");
const { useInboxStore } = await import("../store/inboxStore");

const rowsPerKey = 80;
const now = Date.now();
const source = Object.fromEntries(
  [...REGISTERED_COLLECTION_KEYS, "conversations"].map((key, index) => [
    key,
    Object.fromEntries(
      Array.from({ length: rowsPerKey }, (_, rowIndex) => {
        const _id = `j${String(index * rowsPerKey + rowIndex).padStart(31, "0")}`;
        return [
          _id,
          {
            _id,
            short_id: "ct-1",
            updated_at: now,
            _cachedAt: now,
            title: crypto.randomUUID().repeat(10),
            ...(key === "taskComments" ? { comments: [] } : {}),
          },
        ];
      }),
    ),
  ]),
);
let wireBytes = 0;
const listeners = new Set<Parameters<ReplicationChannel["onMessage"]>[0]>();
const channel: ReplicationChannel = {
  post(message) {
    if (message.type === "snapshotChunk")
      wireBytes += Buffer.byteLength(JSON.stringify(message));
    for (const listen of listeners) listen(structuredClone(message));
  },
  onMessage(listen) {
    listeners.add(listen);
    return () => listeners.delete(listen);
  },
};
const restore = replaceGlobals({
  window: { __CODECAST_ELECTRON__: { [role]: true } },
});
const keys = desktopWindowKeys()?.filter((key) =>
  REPLICATED_STORE_KEYS.includes(key),
);
const host = replicationHostFor("host", channel, () => source);
const receiver: ReplicationChannel = {
  ...channel,
  post(message) {
    channel.post(
      message.type === "hello" && keys ? { ...message, ...{ keys } } : message,
    );
  },
};
const ready = Promise.withResolvers<void>();
useInboxStore.setState({ syncRole: "follower" });
Bun.gc(true);
const before = heapStats().heapSize;
const follower = replicationFollowerFor(
  "panel",
  receiver,
  (synced) => {
    if (synced) ready.resolve();
  },
  undefined,
  keys,
);
try {
  await ready.promise;
  Bun.gc(true);
  const state = useInboxStore.getState();
  const resident = Object.entries(state).filter(
    ([key, value]) => key in source && Object.keys(value ?? {}).length > 0,
  );
  console.log(
    JSON.stringify({
      panel,
      scoped: !!keys,
      keys: resident.length,
      heapBytes: heapStats().heapSize - before,
      snapshotBytes: wireBytes,
    }),
  );
} finally {
  follower.stop();
  host.stop();
  restore();
}
