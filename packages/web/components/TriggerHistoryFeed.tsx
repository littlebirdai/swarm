import { useSyncTriggerHistory } from "../hooks/useSyncTriggers";
import { ErrorBoundary } from "./ErrorBoundary";

function TriggerHistorySync() {
  useSyncTriggerHistory();
  return null;
}

export function TriggerHistoryFeed() {
  return (
    <ErrorBoundary name="Trigger history" fallback={<></>} silent>
      <TriggerHistorySync />
    </ErrorBoundary>
  );
}
