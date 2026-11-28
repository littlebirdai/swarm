import { guestIdentity } from "@codecast/calls/callGuests";
import { parseStagePinRef, stagePinRowId } from "@codecast/calls/stagePins";
import { carryRingStubs, dropSettledRings } from "../../lib/calls/ringStubs";
import { runFilesOf } from "../../lib/calls/callVideo";
import type { AppPermissionKind } from "../../lib/osPermissions";
import type {
  CallRoomFlags,
  GuestWaiting,
  LiveRoom,
  RoomKnock,
} from "../callRoomTypes";
import { liftExcludesForIncoming } from "../chatSlice";
import { REGISTRY_SYNC_OPTS } from "../clientSyncRegistry";
import {
  action,
  asyncAction,
  receiptAsyncAction,
  sync,
} from "../mutativeMiddleware";

export type CallMediaState = {
  phase: "idle" | "ringing_out" | "connecting" | "connected" | "error";
  roomKey: string | null;
  muted: boolean;
  micDenied: boolean;
  camera: boolean;
  sharing: boolean;
  speaking: string[];
  error: string | null;
  errorFix: AppPermissionKind | null;
  reconnecting?: boolean;
  left?: { roomKey: string; at: number } | null;
};

export type CallsSliceState = {
  myCalls: { incoming: any[]; outgoing: any[]; membership: any | null };
  callOccupancy: Record<string, any[]>;
  callConfig: { enabled: boolean; url?: string } | null;
  liveRooms: LiveRoom[];
  roomKnocks: RoomKnock[];
  guestsWaiting: GuestWaiting[];
  callKnocked: Record<string, number>;
  callRooms: Record<string, CallRoomFlags>;
  call: CallMediaState;
};

export type CallsSliceActions = {
  noteKnock: (roomKey: string) => void;
  clearKnock: (roomKey: string) => void;
  setRoomLocked: (roomKey: string, locked: boolean) => void;
  pinToStage: (roomKey: string, ref: string) => void;
  unpinFromStage: (roomKey: string, ref: string) => void;
  pinCallBoard: (roomKey: string) => Promise<{ doc_id: string } | undefined>;
  setRoomTranscribeOff: (roomKey: string, off: boolean) => Promise<unknown>;
  setRoomRecording: (
    roomKey: string,
    on: boolean,
    pressedAt: number,
    runId?: string,
  ) => Promise<unknown>;
  undoRoomRecordingPress: (roomKey: string, on: boolean) => void;
  admitGuestKnock: (guestId: string, name: string) => Promise<unknown>;
  denyGuestKnock: (guestId: string, revokeLink?: boolean) => Promise<unknown>;
  removeCallGuest: (
    roomKey: string,
    guestId: string,
    revokeLink?: boolean,
  ) => Promise<unknown>;
  restoreCallGuest: (
    roomKey: string,
    guest: { identity: string; name: string; joined_at?: number },
  ) => void;
  deleteCallRecording: (recordingId: string) => Promise<unknown>;
  deleteCall: (transcriptId: string) => Promise<unknown>;
  settleCallRecordingTombstones: (
    released: string[],
    collection?: "callRecordings" | "callFrameShares",
  ) => void;
  deleteCallFrameShare: (shareId: string) => Promise<unknown>;
  setCallShareVideo: (
    transcriptId: string,
    include: boolean,
  ) => Promise<unknown>;
  setCallAgentFace: (
    transcriptId: string,
    target: string,
    face: boolean,
  ) => Promise<unknown>;
  setCallState: (patch: Partial<CallMediaState>) => void;
};

export type CallsSlice = CallsSliceState & CallsSliceActions;

type CallsDraft = {
  callRooms: Record<string, CallRoomFlags>;
  callStagePins: Record<string, any>;
  roomKnocks: RoomKnock[];
  liveRooms: LiveRoom[];
  callList: Record<string, any>;
  callDetails: Record<string, any>;
  callRecordings: Record<string, { run_id?: string; transcript_id?: string }>;
  callRecordingCalls: Record<
    string,
    { deleted_here_at?: number; video_shared?: boolean }
  >;
  callFrameShares: Record<string, unknown>;
  pending: Record<string, any>;
  currentUser?: { _id?: string; name?: string } | null;
};

function dropGuestKnock(
  draft: { roomKnocks?: RoomKnock[] },
  guestId: string,
): void {
  const knocks: RoomKnock[] = draft.roomKnocks ?? [];
  if (knocks.some((k) => k.guest_id === guestId)) {
    draft.roomKnocks = knocks.filter((k) => k.guest_id !== guestId);
  }
}

export function rejectDeleteCallRecording(
  draft: Pick<CallsDraft, "callRecordings" | "callRecordingCalls" | "pending">,
  localResult: any,
): string[] | false {
  const rows = localResult.rows;
  if (!Array.isArray(rows)) return false;
  const coll = draft.callRecordings as Record<string, unknown>;
  for (const row of rows) {
    if (typeof row?._id !== "string") continue;
    if (!coll[row._id]) coll[row._id] = row;
    delete draft.pending[`callRecordings:${row._id}`];
  }
  const facts =
    typeof localResult.transcriptId === "string"
      ? draft.callRecordingCalls[localResult.transcriptId]
      : undefined;
  if (facts && facts.deleted_here_at === localResult.at) {
    delete facts.deleted_here_at;
  }
  return ["callRecordings", "callRecordingCalls", "pending"];
}

export const CALLS_SYNC_OPTS = {
  callList: {
    ...REGISTRY_SYNC_OPTS.callList,
    transform: liftExcludesForIncoming("callList"),
  },
  myCalls: {
    kind: "singleton" as const,
    merge: {
      incoming: (_local: any, server: any) => dropSettledRings(server),
      outgoing: (local: any, server: any) => carryRingStubs(local, server),
    },
  },
  callOccupancy: { kind: "singleton" as const },
  callConfig: { kind: "singleton" as const },
  liveRooms: { kind: "list" as const },
};

export function createCallsSlice(set: any): CallsSlice {
  return {
    myCalls: { incoming: [], outgoing: [], membership: null },
    callOccupancy: {},
    callConfig: null,
    liveRooms: [],
    roomKnocks: [],
    guestsWaiting: [],
    callKnocked: {},
    callRooms: {},
    call: {
      phase: "idle" as const,
      roomKey: null,
      muted: true,
      micDenied: false,
      camera: false,
      sharing: false,
      speaking: [],
      error: null,
      errorFix: null,
    },

    setCallState: (patch: Partial<CallMediaState>) =>
      set((s: CallsSliceState) => ({ call: { ...s.call, ...patch } })),

    noteKnock: (roomKey: string) =>
      set((s: CallsSliceState) => ({
        callKnocked: { ...s.callKnocked, [roomKey]: Date.now() },
      })),

    clearKnock: (roomKey: string) =>
      set((s: CallsSliceState) => {
        if (!(roomKey in s.callKnocked)) return {};
        const next = { ...s.callKnocked };
        delete next[roomKey];
        return { callKnocked: next };
      }),

    setRoomLocked: action(function (
      this: CallsDraft,
      roomKey: string,
      locked: boolean,
    ) {
      const row = (this.callRooms[roomKey] ??= {
        _id: roomKey,
        locked: false,
        transcribe_off: false,
        transcribe_off_at: null,
      });
      row.locked = locked;
      return { roomKey, locked };
    }) as CallsSliceActions["setRoomLocked"],

    pinToStage: action(function (
      this: CallsDraft,
      roomKey: string,
      ref: string,
    ) {
      const target = parseStagePinRef(ref);
      if (!target) return;
      const id = stagePinRowId(roomKey, target.ref);
      const me = this.currentUser;
      const was = this.callStagePins[id];
      this.callStagePins[id] = {
        title: null,
        doc_type: null,
        readable: true,
        pinned_by: me?._id ?? "",
        pinned_by_name: me?.name ?? null,
        pinned_by_session: null,
        pinned_by_agent: null,
        ...was,
        _id: id,
        room_key: roomKey,
        ref: target.ref,
        kind: target.kind,
        doc_id: target.kind === "doc" ? target.id : null,
        slug: target.kind === "page" ? target.slug : null,
        at: Date.now(),
      };
      return { roomKey, ref: target.ref };
    }) as CallsSliceActions["pinToStage"],

    unpinFromStage: action(function (
      this: CallsDraft,
      roomKey: string,
      ref: string,
    ) {
      const canonical = parseStagePinRef(ref)?.ref ?? ref;
      delete this.callStagePins[stagePinRowId(roomKey, canonical)];
      return { roomKey, ref: canonical };
    }) as CallsSliceActions["unpinFromStage"],

    pinCallBoard: asyncAction(function (this: CallsDraft, roomKey: string) {
      return { roomKey };
    }) as CallsSliceActions["pinCallBoard"],

    setRoomTranscribeOff: asyncAction(function (
      this: CallsDraft,
      roomKey: string,
      off: boolean,
    ) {
      const row = (this.callRooms[roomKey] ??= {
        _id: roomKey,
        locked: false,
        transcribe_off: false,
        transcribe_off_at: null,
      });
      row.transcribe_off = off;
      row.transcribe_off_at = off ? Date.now() : null;
      return { roomKey, off };
    }) as CallsSliceActions["setRoomTranscribeOff"],

    setRoomRecording: asyncAction(function (
      this: CallsDraft,
      roomKey: string,
      on: boolean,
      _pressedAt: number,
      _runId?: string,
    ) {
      const row = (this.callRooms[roomKey] ??= {
        _id: roomKey,
        locked: false,
        transcribe_off: false,
        transcribe_off_at: null,
      });
      row.recording = on;
      return { roomKey, on };
    }) as CallsSliceActions["setRoomRecording"],

    admitGuestKnock: asyncAction(function (
      this: CallsDraft,
      guestId: string,
      name: string,
    ) {
      dropGuestKnock(this, guestId);
      return { guestId, name };
    }) as CallsSliceActions["admitGuestKnock"],

    denyGuestKnock: asyncAction(function (
      this: CallsDraft,
      guestId: string,
      revokeLink?: boolean,
    ) {
      dropGuestKnock(this, guestId);
      return { guestId, revokeLink: !!revokeLink };
    }) as CallsSliceActions["denyGuestKnock"],

    removeCallGuest: asyncAction(function (
      this: CallsDraft,
      roomKey: string,
      guestId: string,
      revokeLink?: boolean,
    ) {
      dropGuestKnock(this, guestId);
      const identity = guestIdentity(guestId);
      const room = ((this.liveRooms ?? []) as any[]).find(
        (r) => r?.room_key === roomKey,
      );
      if (room?.guests?.some((g: any) => g.identity === identity)) {
        room.guests = room.guests.filter((g: any) => g.identity !== identity);
      }
      return { roomKey, guestId, revokeLink: !!revokeLink };
    }) as CallsSliceActions["removeCallGuest"],

    restoreCallGuest: sync(function (
      this: CallsDraft,
      roomKey: string,
      guest: { identity: string; name: string; joined_at?: number },
    ) {
      const room = ((this.liveRooms ?? []) as any[]).find(
        (r) => r?.room_key === roomKey,
      );
      if (
        room &&
        !(room.guests ?? []).some((g: any) => g.identity === guest.identity)
      ) {
        room.guests = [...(room.guests ?? []), guest];
      }
    }) as CallsSliceActions["restoreCallGuest"],

    undoRoomRecordingPress: sync(function (
      this: CallsDraft,
      roomKey: string,
      on: boolean,
    ) {
      const row = this.callRooms[roomKey];
      if (row && row.recording === on) row.recording = !on;
    }) as CallsSliceActions["undoRoomRecordingPress"],

    deleteCall: asyncAction(function (this: CallsDraft, transcriptId: string) {
      delete this.callList?.[transcriptId];
      delete this.callDetails?.[transcriptId];
    }) as CallsSliceActions["deleteCall"],

    deleteCallRecording: receiptAsyncAction(function (
      this: CallsDraft,
      recordingId: string,
    ) {
      const rows = this.callRecordings;
      const taken = runFilesOf(rows, recordingId);
      const snapshot = JSON.parse(
        JSON.stringify(taken.map(([, r]) => r)),
      ) as Array<{ _id: string; transcript_id?: string }>;
      for (const [id] of taken) delete rows[id];
      const transcriptId = snapshot[0]?.transcript_id ?? null;
      const at = Date.now();
      const facts = transcriptId
        ? this.callRecordingCalls[transcriptId]
        : undefined;
      if (facts) facts.deleted_here_at = at;
      return { recordingId, transcriptId, at, rows: snapshot };
    }) as CallsSliceActions["deleteCallRecording"],

    settleCallRecordingTombstones: sync(function (
      this: CallsDraft,
      released: string[],
      collection: "callRecordings" | "callFrameShares" = "callRecordings",
    ) {
      for (const id of released) {
        const key = `${collection}:${id}`;
        if (this.pending[key]?.type === "exclude") delete this.pending[key];
      }
    }) as CallsSliceActions["settleCallRecordingTombstones"],

    deleteCallFrameShare: asyncAction(function (
      this: CallsDraft,
      shareId: string,
    ) {
      delete this.callFrameShares[shareId];
      return { shareId };
    }) as CallsSliceActions["deleteCallFrameShare"],

    setCallShareVideo: asyncAction(function (
      this: CallsDraft,
      transcriptId: string,
      include: boolean,
    ) {
      const row = this.callRecordingCalls[transcriptId];
      if (row) row.video_shared = include;
      return { transcriptId, include };
    }) as CallsSliceActions["setCallShareVideo"],

    setCallAgentFace: asyncAction(function (
      this: CallsDraft,
      transcriptId: string,
      target: string,
      face: boolean,
    ) {
      const call = this.callDetails[transcriptId] as
        | { routes?: Array<{ kind: string; target: string; face?: boolean }> }
        | undefined;
      const route = call?.routes?.find(
        (r) => r.kind === "session" && r.target === target,
      );
      if (route) {
        if (face) delete route.face;
        else route.face = false;
      }
      return { transcriptId, target, face };
    }) as CallsSliceActions["setCallAgentFace"],
  };
}
