import { sync } from "@platform/engine";
import type { InboxSession, InboxStoreState } from "./inboxStore";

export function stageSessionReconfigure(
  session: InboxSession | undefined,
  args: Record<string, unknown> | undefined,
): void {
  if (!session || !args) return;
  const device = args.cloud_device_id ?? args.target_device_id;
  if (typeof device === "string") session.owner_device_id = device;
  if (typeof args.project_path === "string") {
    session.project_path = args.project_path;
    session.git_root =
      typeof args.git_root === "string" ? args.git_root : args.project_path;
  }
}

// The machine row's stamp. Local-only (`sync`): the conversations table has no
// such column — the value's only job is to survive on the stub row until
// createSessionFromStub reads it. Null clears a pick the user reverted.
export const setSessionTargetDevice = sync(function (
  this: InboxStoreState,
  id: string,
  deviceId: string | null,
) {
  if (this.sessions[id]) this.sessions[id].target_device_id = deviceId;
  if (this.conversations[id])
    (this.conversations[id] as any).target_device_id = deviceId;
});
