import { installSignedInPrincipal } from "../store/__tests__/fixtures/signedInPrincipal";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { act, useLayoutEffect } from "react";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { _reopenForTests } from "../store/idb-cache";
import { db } from "../store/persistence/db";
import { flushSyncPublishes } from "../store/syncTransaction";
import type { SteerClaimState } from "../store/steer-composer-state";
import {
  SteerClaimFeeder,
  useLiveComposerControl,
} from "../hooks/use-live-composer-control";
import {
  collaborator,
  createComposerMount,
  owner,
} from "./composer-control-fixture";
import { replaceGlobals } from "./globals";
import { mountWeb } from "./mountWeb";

const mount = createComposerMount(mountWeb);
export const signedInViewer = "b".repeat(32) as Id<"users">;
installSignedInPrincipal(signedInViewer);
export const principalStorage = localStorage;
await _reopenForTests({ indexedDB, IDBKeyRange });

export async function settleRecoveryWrites() {
  await act(async () => {
    await db.meta.count();
    await db.meta.count();
  });
}

let nextId = 0;
export function claimState(): SteerClaimState {
  const _id = (++nextId).toString().padStart(32, "a") as Id<"conversations">;
  const viewer = signedInViewer;
  return {
    _id,
    viewer,
    owner: true,
    turn: { id: "turn", run: 1, start_event_seq: 10 },
    holder: { id: viewer, name: "Owner" },
    baton_token: 1,
    delivery: null,
    takeover_pending: false,
    fence_id: null,
    can_take_over: true,
    can_send: true,
    can_steer: true,
    drive_requested: false,
    fresh_for_ms: 30000,
    queue: { items: [], more: false },
  };
}
export const driver = { id: "c".repeat(32) as Id<"users">, name: "Ana" };

export type DropFiles = { current: ((files: File[]) => void) | null };

function Composer({
  row,
  enabled = true,
  dropFiles,
}: {
  row: SteerClaimState;
  enabled?: boolean;
  dropFiles?: DropFiles;
}) {
  useLayoutEffect(
    () =>
      replaceGlobals({
        dispatchEvent: window.dispatchEvent.bind(window),
      }),
    [],
  );
  const control = useLiveComposerControl(
    enabled ? row._id : undefined,
    row.viewer,
  );
  return (
    <>
      {enabled && <SteerClaimFeeder scope={row._id} viewerId={row.viewer} />}
      {row.owner
        ? owner(row._id, control, {
            acceptFiles: !!dropFiles,
            onDropFiles: dropFiles,
          })
        : collaborator(row._id, control ?? { enabled: false })}
    </>
  );
}

export async function show(
  row: SteerClaimState,
  status: string | { status: string; code?: string } = "acknowledged",
  enabled = true,
  dropFiles?: DropFiles,
) {
  const ui = await mount(
    <Composer row={row} enabled={enabled} dropFiles={dropFiles} />,
    {
      setup(backend) {
        backend.set(api.collab.steerClaimState, row);
        backend.set(api.collab.mySendAccess, { level: "shared" });
        backend.set(api.devices.getConversationMachine, null);
        backend.mutation(
          api.dispatch.dispatch,
          typeof status === "string" ? { status } : status,
        );
      },
    },
  );
  await act(async () => flushSyncPublishes());
  return {
    ...ui,
    async press(...args: Parameters<typeof ui.press>) {
      await ui.press(...args);
      await settleRecoveryWrites();
    },
  };
}

export async function publishClaim(
  ui: Awaited<ReturnType<typeof show>>,
  row: SteerClaimState | null,
) {
  await act(() => ui.backend.set(api.collab.steerClaimState, row));
  await act(async () => flushSyncPublishes());
}
