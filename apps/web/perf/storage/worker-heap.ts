import { join } from "node:path";

type HeapUsage = {
  usedSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
};

export async function sampleWorkerHeap(
  profile: string,
  pageUrl: string,
  workerName: string,
): Promise<HeapUsage | null> {
  const endpoint = Bun.file(join(profile, "DevToolsActivePort"));
  if (!(await endpoint.exists())) return null;
  const [port] = (await endpoint.text()).trim().split("\n");
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = (await response.json()) as {
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find(({ url }) => url === pageUrl);
  if (!page) return null;
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise<HeapUsage | null>((resolve, reject) => {
    const timeout = setTimeout(() => finish(null), 2000);
    function finish(value: HeapUsage | null, error?: Error) {
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    }
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Target.setAutoAttach",
          params: {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          },
        }),
      );
    socket.onerror = () => finish(null);
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.error) {
        finish(null, new Error(message.error.message));
      } else if (message.id === 2) {
        finish(message.result);
      } else if (
        message.method === "Target.attachedToTarget" &&
        message.params.targetInfo.type === "worker" &&
        message.params.targetInfo.title === workerName
      ) {
        socket.send(
          JSON.stringify({
            id: 2,
            sessionId: message.params.sessionId,
            method: "Runtime.getHeapUsage",
          }),
        );
      }
    };
  });
}
