import type { ServerWebSocket } from "bun";
import type { RelaySocket } from "@codecast/relay/effect";

type BunSocket = Pick<
  ServerWebSocket<unknown>,
  "sendText" | "getBufferedAmount" | "close" | "terminate"
>;

export class BunRelaySocket implements RelaySocket {
  constructor(private readonly socket: BunSocket) {}

  static isWritable(socket: Pick<BunSocket, "getBufferedAmount">): boolean {
    return socket.getBufferedAmount() === 0;
  }

  send(text: string) {
    const size = this.socket.sendText(text);
    if (size === 0) return "closed";
    return size < 0 || !BunRelaySocket.isWritable(this.socket)
      ? "paused"
      : "sent";
  }

  close(code: number) {
    this.socket.close(code);
  }

  terminate() {
    this.socket.terminate();
  }
}
