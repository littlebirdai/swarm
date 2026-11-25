import { type JSONValue } from "convex/values";

type Request = {
  requestId: number;
  udfPath: string;
  args: JSONValue[];
};

export type Subscription = {
  type: "Add";
  queryId: number;
  udfPath: string;
  args: JSONValue[];
};

export type ClientFrame =
  | { type: "Connect" | "Event" }
  | { type: "Authenticate"; baseVersion: number }
  | {
      type: "ModifyQuerySet";
      newVersion: number;
      modifications: (Subscription | { type: "Remove"; queryId: number })[];
    }
  | (Request & { type: "Mutation" | "Action" });

export type QueryUpdate =
  | { type: "QueryUpdated"; queryId: number; value: JSONValue; logLines: [] }
  | { type: "QueryFailed"; queryId: number; errorMessage: string; logLines: [] }
  | { type: "QueryRemoved"; queryId: number };

export class TestSocket {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;

  constructor(private readonly receive: (frame: ClientFrame) => void) {
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string) {
    const frame: ClientFrame = JSON.parse(data);
    queueMicrotask(() => {
      if (this.readyState === 1) this.receive(frame);
    });
  }

  reply(frame: object) {
    if (this.readyState === 1)
      this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close() {
    this.readyState = 3;
    const onclose = this.onclose;
    this.onopen = this.onclose = this.onmessage = undefined;
    onclose?.();
  }
}
