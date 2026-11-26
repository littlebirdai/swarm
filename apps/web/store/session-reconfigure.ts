import { sync, type DispatchFn } from "@platform/engine";
import type { InboxStoreState } from "./inboxStore";

type SessionReconfigure = {
  deviceId?: string;
  projectPath?: string;
};

const sessionReconfigureLock = (id: string) => `sessionReconfigures::${id}`;

export function stageSessionReconfigure(
  state: SessionReconfigureSlice,
  convId: string,
  args: Record<string, unknown> | undefined,
): void {
  const deviceId = args?.cloud_device_id ?? args?.target_device_id;
  const projectPath = args?.project_path;
  if (typeof deviceId === "string" || typeof projectPath === "string") {
    state.sessionReconfigures[convId] = {
      ...(typeof deviceId === "string" ? { deviceId } : {}),
      ...(typeof projectPath === "string" ? { projectPath } : {}),
    };
  }
}

export const sessionReconfigureSlice = {
  sessionReconfigures: {} as Record<string, SessionReconfigure>,
  _restoreSessionReconfigure: sync(function (
    this: InboxStoreState,
    id: string,
    lock: string,
  ) {
    const pending = this.pending[sessionReconfigureLock(id)];
    if (pending?.lock === lock && !this.sessionReconfigures[id])
      this.sessionReconfigures[id] = pending.value as SessionReconfigure;
  }),

  _acknowledgeSessionReconfigure: sync(function (
    this: InboxStoreState,
    id: string,
    lock: string,
  ) {
    const key = sessionReconfigureLock(id);
    if (this.pending[key]?.lock !== lock) return;
    const pick = this.pending[key].value as SessionReconfigure;
    if (pick.deviceId) {
      this.sessionReconfigures[id] = { deviceId: pick.deviceId };
    } else {
      delete this.sessionReconfigures[id];
    }
    delete this.pending[key];
  }),

  // The machine row's stamp. Local-only (`sync`): the conversations table has no
  // such column — the value's only job is to survive on the stub row until
  // createSessionFromStub reads it. Null clears a pick the user reverted.
  setSessionTargetDevice: sync(function (
    this: InboxStoreState,
    id: string,
    deviceId: string | null,
  ) {
    if (this.sessions[id]) this.sessions[id].target_device_id = deviceId;
    if (this.conversations[id])
      (this.conversations[id] as any).target_device_id = deviceId;
  }),

  pickStubSessionTarget: sync(function (
    this: InboxStoreState,
    id: string,
    deviceId: string | null,
  ) {
    if (deviceId) {
      this.sessionReconfigures[id] = { deviceId };
    } else {
      delete this.sessionReconfigures[id];
    }
  }),
};

export type SessionReconfigureSlice = {
  [Key in keyof typeof sessionReconfigureSlice]: OmitThisParameter<
    (typeof sessionReconfigureSlice)[Key]
  >;
};

export function withSessionReconfigureAcknowledgement(
  dispatch: DispatchFn,
  get: () => SessionReconfigureSlice,
): DispatchFn {
  return (action, args, patches, result, commandId, meta) => {
    const id =
      action === "convCommand" &&
      args?.[1] === "reconfigureSession" &&
      typeof args[0] === "string"
        ? args[0]
        : undefined;
    const lock =
      id &&
      meta?.locks.find((entry) => entry.key === sessionReconfigureLock(id));
    if (id && lock && !get().sessionReconfigures[id])
      get()._restoreSessionReconfigure(id, lock.lock);
    const response = dispatch(action, args, patches, result, commandId, meta);
    if (!id || !lock) return response;
    return response.then((value) => {
      get()._acknowledgeSessionReconfigure(id, lock.lock);
      return value;
    });
  };
}
