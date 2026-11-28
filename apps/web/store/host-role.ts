import { useInboxStore } from "./inboxStore";
import { sweepRevokedRowsFromDisk } from "./scope-revocation-disk";

export type HostRoleSteps = {
  installWriter: () => void;
  setRole: () => void;
  start: () => void;
  useDiskCache: () => void;
};

export function takeHostRole(steps: HostRoleSteps): void {
  steps.installWriter();
  useInboxStore.getState().adoptScopeRevocations(Date.now());
  const held = Object.keys(useInboxStore.getState().scopeRevocations ?? {});
  if (held.length > 0)
    void sweepRevokedRowsFromDisk(new Set(held)).catch(() => {});
  steps.setRole();
  steps.start();
  steps.useDiskCache();
}
