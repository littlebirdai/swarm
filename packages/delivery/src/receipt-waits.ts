import type { PermitsNextRequest } from "@codecast/edge-contract";
import { setBoundedMap } from "./journals";

export type ReceiptWaits = ReturnType<typeof makeReceiptWaits>;

export function makeReceiptWaits() {
  const awaiting = new Map<string, PermitsNextRequest>();
  const refused = new Map<string, PermitsNextRequest>();
  return {
    expect: (run: PermitsNextRequest) => {
      refused.delete(run.session);
      setBoundedMap(awaiting, run.session, run);
    },
    awaiting: (session: string) => awaiting.get(session),
    refuse: (run: PermitsNextRequest) => {
      setBoundedMap(refused, run.session, run);
    },
    refused: () => [...refused.values()],
    clear: (session: string) => {
      awaiting.delete(session);
      refused.delete(session);
    },
  };
}
