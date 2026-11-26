import { useSyncDocsPaginated } from "@codecast/web/hooks/use-sync-docs";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncDocs() {
  return useSyncDocsPaginated(useWorkspaceArgs());
}
