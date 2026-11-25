import { mock } from "bun:test";
import * as livekit from "livekit-client";
import {
  ConnectionState,
  Track,
  type LocalParticipant,
  type RoomOptions,
} from "livekit-client";

export class FakeRoom {
  static made: FakeRoom[] = [];
  static connectError: Error | null = null;
  static onPublish: (() => void) | null = null;
  connects = 0;
  disconnects = 0;
  micCalls: boolean[] = [];
  published: unknown[] = [];
  micPublication: {
    muted: boolean;
    track: unknown;
    mute: () => Promise<void>;
  } | null = null;
  enabledAtPublish: boolean | null = null;
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
    setMicrophoneEnabled: async (on: boolean) => {
      this.micCalls.push(on);
      if (this.micPublication) this.micPublication.muted = !on;
    },
    publishTrack: async (track: unknown) => {
      this.published.push(track);
      FakeRoom.onPublish?.();
      this.enabledAtPublish =
        (track as { enabled?: boolean } | null)?.enabled ?? null;
      const publication = {
        muted: false,
        track,
        mute: async () => {
          publication.muted = true;
        },
      };
      this.micPublication = publication;
      return publication;
    },
    getTrackPublication: (source?: Track.Source) =>
      source === Track.Source.Microphone
        ? (this.micPublication ?? undefined)
        : undefined,
  };
  constructor(readonly opts?: RoomOptions) {
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
    this.connects++;
    if (FakeRoom.connectError) throw FakeRoom.connectError;
    this.state = ConnectionState.Connected;
  }
  async disconnect() {
    this.disconnects++;
    this.state = ConnectionState.Disconnected;
  }
}

export function standInForLiveKitRoom() {
  const real = { ...livekit };
  mock.module("livekit-client", () => ({ ...real, Room: FakeRoom }));
  return () => mock.module("livekit-client", () => real);
}
