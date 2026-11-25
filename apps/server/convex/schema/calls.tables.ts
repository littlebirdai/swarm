import { defineTable } from "convex/server";
import { v } from "convex/values";
import { callTables } from "../callsSchema";
import { callRoomTables } from "../callRoomSchema";

export const callAndTranscriptTables = {
  // Huddle roster: one row per (room, member), each member writing ONLY their
  // own row — never a shared room document, so a full room has no hot-document
  // writer pileup. A room is a KEY, not an entity: "dm:<id>:<id>[:<id>…]" (a
  // sorted set of people — a chat DM or group thread huddles in the room of
  // its members), "channel:<chat_channel id>", "session:<conversation id>". It exists
  // while occupied and vanishes when the last row goes stale. Lifetime is a
  // lease (terminal-streaming philosophy): the client heartbeats last_seen
  // in-call, readers filter rows older than CALL_MEMBER_STALE_MS, so a crashed
  // client, killed tab and lost network all converge on "left" with no
  // teardown message. Media itself never touches Convex — this table is the
  // control-plane roster (who is in the room, muted/camera/sharing flags for
  // occupancy chips); audio/video flows through LiveKit.
  call_members: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    user_id: v.id("users"),
    // Denormalized for cheap occupancy-chip paint (no user join per row).
    user_name: v.string(),
    user_image: v.optional(v.string()),
    joined_at: v.number(),
    last_seen: v.number(),
    muted: v.boolean(),
    camera: v.boolean(),
    sharing: v.boolean(),
    // THIS PERSON STEPPED INTO A WALKIE BURST ON PURPOSE, and when.
    //
    // A burst puts everyone who hears it in the room, so being seated says
    // nothing about whether a conversation started. The mic used to answer
    // that — an open mic meant somebody had joined — and it stopped being an
    // answer when auto-listen went hot: every listener's mic is open now, so
    // every listener would read as a conversation.
    //
    // So the intent is stamped rather than inferred. The client sets it only
    // for the deliberate "Join live" gesture, and both sides read it off the
    // roster they already subscribe to: another person's stamp on my walkie
    // room is what turns the strip into the call dock, on their screen and on
    // mine. Absent on every ordinary join, which is why it is optional.
    walkie_joined_at: v.optional(v.number()),
    // NOBODY IS HERE. This row is a media connection held open ahead of a
    // burst, so the first word is audible instead of recorded: opening a DM or
    // resting on a face connects to the SFU early, publishes nothing, and
    // waits. The person has not walked in, cannot hear anyone and cannot be
    // heard.
    //
    // So a prewarm row is not a member, and `liveMembers` drops it — that one
    // helper is what every reader of this table already asks, which is why the
    // rule lives there rather than in each of them. Occupancy chips, "X hears
    // you", the live-rooms list, invite grants and the room's own lease all
    // inherit it. A real join clears the flag on the same row and the seat
    // becomes ordinary.
    prewarm: v.optional(v.boolean()),
    // Languages this seat's device is set to (ISO-639-1). The huddle's
    // transcriber unions every live seat so a Japanese speaker in a room the
    // English client is scribing is still heard in Japanese. Optional: older
    // clients never send it, and it never leaves this table into occupancy.
    languages: v.optional(v.array(v.string())),
  })
    .index("by_room", ["room_key"])
    .index("by_user", ["user_id"])
    .index("by_user_room", ["user_id", "room_key"])
    // Every live huddle in one of my teams (calls.getLiveRooms). A team-wide
    // subscription, so that query bucket-rounds every timestamp it returns and
    // sorts its rooms — a heartbeat writing last_seen must not re-push the
    // whole list to everyone on the team.
    .index("by_team", ["team_id"]),

  ...callRoomTables,

  // A huddle transcription session ("scribe"). One row per recording run,
  // owned by whoever toggled Transcribe on — that client holds every audio
  // track (its own mic + each subscribed remote track), transcribes each
  // track separately, and writes attributed segments below. Attribution is
  // therefore STRUCTURAL: one LiveKit track = one participant, no diarization.
  // Routes say where the words go: an agent session (delivered like `cast
  // send`, so the agent replies in its own thread), a doc (appended), or a
  // linked Slack channel. mode "live" ships accumulated segments every time
  // the room goes quiet (server VAD gap) — which is exactly the beat where an
  // agent should speak up; "after" ships one transcript at stop.
  transcripts: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    started_by: v.id("users"),
    status: v.union(v.literal("live"), v.literal("ended")),
    started_at: v.number(),
    ended_at: v.optional(v.number()),
    title: v.optional(v.string()),
    // The call's board: a board doc made when the first agent joined (or a
    // person pressed Board on the stage), pinned on the stage and kept up by
    // the agents in the room (callStage.ensureCallBoard). Outlives the pins.
    board_doc_id: v.optional(v.id("docs")),
    // A transcript IS the durable call object (the calls page, cast calls).
    // Who spoke — accumulated from segment speaker ids as they append, so it
    // reflects actual voices, not seat leases.
    participants: v.optional(
      v.array(v.object({ id: v.string(), name: v.string() })),
    ),
    // Generated when the transcript ends (internal.transcripts.generateSummary):
    // a few sentences of what happened, plus extracted action items.
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
    summary_status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("done"),
        v.literal("failed"),
        // Too little was said to summarize.
        v.literal("skipped"),
      ),
    ),
    // The rolling recap while the call is live (transcripts.flush claims a
    // run, generateSummary { rolling: true } writes it): when the last run
    // was claimed and the segment seq it covered. The throttle reads both;
    // summary_status stays untouched until the call ends.
    summary_at: v.optional(v.number()),
    summary_seq: v.optional(v.number()),
    routes: v.array(
      v.object({
        kind: v.union(
          v.literal("session"),
          v.literal("doc"),
          v.literal("slack"),
        ),
        // session: conversation short id or id (sendSessionMessage resolves);
        // doc: docs._id; slack: channel id of a linked channel.
        target: v.string(),
        mode: v.union(v.literal("live"), v.literal("after")),
        // Watermark: segments with seq <= this have been delivered.
        sent_seq: v.number(),
        // Who pointed this route at the call. Delivery acts as this user (a
        // participant feeding an agent speaks as themselves); absent on routes
        // the scribe configured before this field existed → started_by.
        added_by: v.optional(v.id("users")),
        // Session routes: false when the person who added the agent left its
        // video avatar out (callFace.ts). Absent: the team's default, a face.
        face: v.optional(v.boolean()),
        // A hold the fed agent asked for (`cast call hold`): live delivery to
        // this session waits until then, except for words that name it. The
        // hold's expiry schedules the catch up delivery.
        hold_until: v.optional(v.number()),
        // Session routes: chunks delivered since the last one that carried
        // the full huddle framing (needsFullBrief). Absent → none yet.
        briefed_chunks: v.optional(v.number()),
        // Session routes: when the last context lane chunk went out; the next
        // waits CONTEXT_MIN_GAP_MS unless a line names the agent.
        context_at: v.optional(v.number()),
      }),
    ),
    // Monotonic per-transcript segment counter (writer-owned; the scribe is
    // the only appender, so no contention).
    last_seq: v.number(),
    // A RECORDING'S LEASE. A huddle's transcript is kept alive by the room's
    // seat leases (call_members), and the orphan sweep ends it when they go
    // stale. A recording has no room and therefore no seats, so it carries the
    // lease itself: the engine beats this field while it records, and a
    // transcript whose beat went stale is a browser tab that died mid-sentence.
    // Same window, same reason, one less table.
    last_beat: v.optional(v.number()),
    // A HUDDLE'S GRACE. A transcript is the record of one huddle: it lives
    // from the first seat to the room standing empty, and transcription
    // switched off and on inside that span is a gap in it, never a new call.
    // When the last person leaves this stamps the moment the room emptied;
    // somebody back within HUDDLE_GRACE_MS clears it and the same record goes
    // on, and otherwise the record ends at this moment (endIdleTranscript).
    idle_since: v.optional(v.number()),
    // The room's own session route is owed, not yet given. A press of Record
    // in a session huddle with transcription off begins the record without
    // it, because that route makes the session's agent a participant and
    // recording a room must never invite anyone into it. Transcription coming
    // back on pays it (transcripts.ensureOwnRoute) and clears this. A mark
    // rather than a check of the routes, so a route somebody removed on
    // purpose is never put back.
    own_route_owed: v.optional(v.boolean()),
    // The audio, when there is any. A recording (`rec:` room key) uploads what
    // its microphone heard once it stops; a huddle has no single recording to
    // keep. Best effort by design — the transcript is the artifact, and a
    // failed upload must never cost anyone their words.
    recording_storage_id: v.optional(v.id("_storage")),
    // A SCREEN RECORDING: a video somebody recorded on their own screen while
    // talking and sent to a session (screenRecordings.ts). The file is its
    // call_recordings row (kind "screen") once uploaded; until then this
    // holds the object key the client is uploading to. `no_audio` marks a
    // video with no sound track (the microphone was off), so the surfaces
    // can say that instead of "no words".
    // `conversation_id` is the session it was sent to: who can read that
    // session can read the recording (canReadRoomlessCall), and it stays out
    // of everyone's call history, triggers and pushes (a message in a
    // session, not a call anybody held).
    screen_recording: v.optional(
      v.object({
        conversation_id: v.optional(v.id("conversations")),
        r2_key: v.string(),
        requested_at: v.number(),
        mime: v.string(),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        no_audio: v.optional(v.boolean()),
        // When its one transcription was scheduled (screenRecordings.startProcessing).
        processing_at: v.optional(v.number()),
        // When a message carrying its tag was queued into its session: the
        // unsent sweep keeps it from then on.
        sent_at: v.optional(v.number()),
      }),
    ),
    // Reading the words back OUT of that audio, for a recorder that had no
    // recognizer of its own. A phone cannot stream microphone audio to the live
    // recognizer — React Native has no AudioContext — so its recording arrives
    // as a finished file with an empty transcript, and the server transcribes
    // it once the upload lands. Absent on every transcript that got its words
    // live, which is every huddle and every desktop recording that worked.
    transcribe_status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("done"),
        // The audio is there and playable; the words could not be read out of
        // it. Said plainly in the UI rather than left spinning.
        v.literal("failed"),
      ),
    ),
    // A recording (`rec:` room key) or a meeting bot's call (`meet:`) its
    // creator shared into a team. Absent or
    // false is every recording's birth state: private to the creator, whatever
    // team_id says (team_id is routing, never access — canReadCall is the
    // gate). Meaningless on huddles, which have the room's own rules.
    rec_shared: v.optional(v.boolean()),
    // A huddle started private (call_room_state.private). Its record belongs
    // to the people who were in it: whoever spoke, was filmed or started it,
    // and for a people room the people its key names. Room membership that
    // reaches further (a team-visible session, a channel) grants nothing here.
    private: v.optional(v.boolean()),
    // Public sharing: "anyone with the link" (publicShare.ts). A grant to
    // read this one call's record, never to join its room.
    share_token: v.optional(v.string()),
    // The share link whose holders may also watch the call's video: the
    // share_token at the moment somebody chose to include it
    // (callRecordings.setCallShareVideo). A link made for the transcript
    // never shows faces and screens by itself, and a link turned off and on
    // again is a new token, so it never inherits the choice.
    share_video_token: v.optional(v.string()),
    // The moment the video was chosen for that link: room videos pressed for
    // up to then are on it, and a run recorded later waits for a fresh choice
    // (lib/callRecordingRuns.sharedVideoRuns). Absent on links shared before
    // the cutoff existed, which show every finished room video.
    share_video_through: v.optional(v.number()),
    // Everyone a recording of this huddle showed: seated when a run started,
    // or seated while one ran (lib/callRecordingRuns.noteRecordedPeople).
    // canReadCall admits them like speakers, so a person who was filmed but
    // never spoke (or pressed Record with transcription off) can watch it.
    recorded_people: v.optional(v.array(v.id("users"))),
    // How many of this call's recording files are not failed
    // (lib/callRecordingRuns.syncCallVideo): the call's own video fact,
    // apart from recorded_people, which is who may watch and outlives the
    // video. callFilmed reads it. Absent means none.
    video_runs: v.optional(v.number()),
    // A live record a Record press made (callRecordings.startRecording) that
    // no client has scribed yet: started_by is the presser and owns it, but
    // transcripts.start hands the scribe seat to the first client that asks
    // and clears this. getLive reports no scribe while it is set.
    scribe_open: v.optional(v.boolean()),
    // "cl-N" from counters.nextShortId: the handle a call is quoted by in
    // prose (`cl-42`, `cl-42:15-25` for turns 15 to 25), like ct-/pl-.
    // Optional only for rows older than the backfill.
    short_id: v.optional(v.string()),
  })
    .index("by_short_id", ["short_id"])
    .index("by_share_token", ["share_token"])
    .index("by_room", ["room_key"])
    .index("by_status", ["status"])
    // The calls page / cast calls: a team's call history, newest first.
    .index("by_team_started", ["team_id", "started_at"])
    // The same page's personal shelf: everything I started, newest first —
    // how a recording is found regardless of which team it was filed under.
    .index("by_creator_started", ["started_by", "started_at"]),

  transcript_segments: defineTable({
    transcript_id: v.id("transcripts"),
    seq: v.number(),
    speaker_id: v.string(),
    speaker_name: v.string(),
    text: v.string(),
    // Milliseconds since transcript start (scribe's clock, one clock for all
    // tracks, so cross-speaker ordering is honest).
    t0: v.number(),
    t1: v.number(),
  })
    .index("by_transcript_seq", ["transcript_id", "seq"])
    // Search over what was said, one call at a time (transcripts.webSearchCalls
    // filters by the calls the viewer may read, so access never rides on it).
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["transcript_id"],
    }),

  ...callTables,
};
