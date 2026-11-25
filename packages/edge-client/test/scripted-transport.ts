import type { EdgeOperation, EdgeRequests, EdgeTransport } from "../src";

type Exchange = {
  operation: EdgeOperation;
  request: EdgeRequests[EdgeOperation];
  signal: AbortSignal;
};

export type Step = (exchange: Exchange) => ReturnType<EdgeTransport>;

export const reply =
  (body: unknown, status = 200): Step =>
  async () => ({ status, body });

export function scriptedTransport(...steps: Step[]) {
  const calls: Exchange[] = [];
  const transport: EdgeTransport = (operation, request, signal) => {
    const exchange = { operation, request: structuredClone(request), signal };
    const step = steps[calls.length];
    calls.push(exchange);
    return step
      ? step(exchange)
      : Promise.reject(new Error("Unexpected exchange"));
  };
  return { calls, transport };
}
