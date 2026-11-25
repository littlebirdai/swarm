function parseMessage(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function createSocketMeter() {
  const sockets = new Map();
  const byQuery = new Map();
  let totalBytes = 0;
  let frames = 0;

  function record({ method, params }, measuring) {
    if (!params) return;
    const { requestId } = params;
    if (method === "Network.webSocketClosed") {
      sockets.delete(requestId);
      return;
    }
    const created = method === "Network.webSocketCreated";
    const sent = method === "Network.webSocketFrameSent";
    const received = method === "Network.webSocketFrameReceived";
    if (!created && !sent && !received) return;

    const frame = params.response;
    const message =
      frame?.opcode === 1 ? parseMessage(frame.payloadData) : null;
    let socket = sockets.get(requestId);
    if (!socket) {
      const recognized = created
        ? /\/api\/[^/]+\/sync$/.test(new URL(params.url).pathname)
        : sent
          ? message?.type === "ModifyQuerySet"
          : message?.type === "Transition" ||
            message?.type === "TransitionChunk";
      if (!recognized) return;
      socket = { names: new Map(), chunks: new Map() };
      sockets.set(requestId, socket);
    }

    if (sent && message?.type === "ModifyQuerySet") {
      for (const mod of message.modifications ?? []) {
        if (mod.type === "Add") socket.names.set(mod.queryId, mod.udfPath);
      }
    }
    if (!received) return;
    if (measuring) {
      totalBytes += Buffer.byteLength(
        frame.payloadData,
        frame.opcode === 1 ? "utf8" : "base64",
      );
      frames++;
    }

    let transition = message;
    if (message?.type === "TransitionChunk") {
      const { transitionId, partNumber, totalParts, chunk } = message;
      if (
        !Number.isInteger(totalParts) ||
        !Number.isInteger(partNumber) ||
        partNumber < 0 ||
        partNumber >= totalParts ||
        typeof chunk !== "string"
      )
        return;
      const parts = socket.chunks.get(transitionId) ?? new Map();
      parts.set(partNumber, chunk);
      if (parts.size !== totalParts) {
        socket.chunks.set(transitionId, parts);
        return;
      }
      socket.chunks.delete(transitionId);
      transition = parseMessage(
        [...parts]
          .sort(([a], [b]) => a - b)
          .map(([, part]) => part)
          .join(""),
      );
    }

    if (!measuring || transition?.type !== "Transition") return;
    for (const mod of transition.modifications ?? []) {
      const name =
        socket.names.get(mod.queryId) ?? `query#${requestId}:${mod.queryId}`;
      const prior = byQuery.get(name) ?? { bytes: 0, frames: 0 };
      prior.bytes += Buffer.byteLength(JSON.stringify(mod));
      prior.frames++;
      byQuery.set(name, prior);
    }
  }

  return {
    record,
    openSocket: () =>
      sockets.size === 1 ? sockets.keys().next().value : undefined,
    snapshot: () => ({
      totalBytes,
      frames,
      byQuery: new Map(
        [...byQuery].map(([name, stats]) => [name, { ...stats }]),
      ),
    }),
  };
}
