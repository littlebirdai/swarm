import { mock } from "bun:test";
import * as livekit from "livekit-client";
import { ConnectionState, type LocalParticipant } from "livekit-client";

export class FakeRoom {
  static made: FakeRoom[] = [];
  static connectError: Error | null = null;
  state: ConnectionState = ConnectionState.Disconnected;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  remoteParticipants = new Map<string, unknown>();
  localParticipant = {
    identity: "me",
    name: "Me",
    metadata: undefined as string | undefined,
    setScreenShareEnabled: mock(
      async (
        ..._args: Parameters<LocalParticipant["setScreenShareEnabled"]>
      ) => ({ track: {} }),
    ),
    setMicrophoneEnabled: async () => {},
    publishTrack: async (t: unknown) => ({
      muted: false,
      track: t,
      mute: async () => {},
    }),
    getTrackPublication: () => undefined,
  };
  constructor() {
    FakeRoom.made.push(this);
  }
  on(event: string, cb: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  async connect() {
    if (FakeRoom.connectError) throw FakeRoom.connectError;
    this.state = ConnectionState.Connected;
  }
  async disconnect() {
    this.state = ConnectionState.Disconnected;
  }
}

export function standInForLiveKitRoom() {
  const real = { ...livekit };
  mock.module("livekit-client", () => ({ ...real, Room: FakeRoom }));
  return () => mock.module("livekit-client", () => real);
}
