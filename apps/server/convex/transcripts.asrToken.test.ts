import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FALLBACK_TRANSCRIBE_MODEL,
  LIVE_TRANSCRIBE_MODEL,
} from "@codecast/calls/transcribeLanguage";
import { api } from "./_generated/api";
import { dmRoomKey } from "./callRooms";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
let posts: { url: string; method?: string; auth: string; session: any }[];
let replies: Response[];

beforeEach(() => {
  posts = [];
  replies = [];
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    posts.push({
      url: String(url),
      method: init.method,
      auth: new Headers(init.headers).get("authorization")!,
      session: JSON.parse(String(init.body)).session,
    });
    return replies.shift()!;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
});

async function room() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "asr token");
    const team = await rows.team({ features: { calls: true } });
    const caller = await rows.user({ team_id: team });
    const mate = await rows.user({ team_id: team });
    const outsider = await rows.user();
    await rows.membership(caller, team);
    await rows.membership(mate, team);
    const room_key = dmRoomKey([caller, mate]);
    await db.insert("call_members", {
      room_key,
      team_id: team,
      user_id: mate,
      user_name: "Mate",
      joined_at: Date.now(),
      last_seen: Date.now(),
      muted: false,
      camera: false,
      sharing: false,
      languages: ["ja"],
    });
    return { caller, outsider, room_key };
  });
  return { t, ...ids };
}

const minted = () => Response.json({ value: "secret" });
const refused = () => new Response("{}", { status: 400 });

describe("mintAsrToken", () => {
  test("sends the languages of the caller and the room to the live model", async () => {
    const { t, caller, room_key } = await room();
    replies = [minted()];
    expect(
      await asUser(t, caller).action(api.transcripts.mintAsrToken, {
        room_key,
        languages: ["en"],
      }),
    ).toEqual({
      client_secret: "secret",
      model: LIVE_TRANSCRIBE_MODEL,
      languages: ["en", "ja"],
    });
    expect(posts).toEqual([
      {
        url: "https://api.openai.com/v1/realtime/client_secrets",
        method: "POST",
        auth: "Bearer test-key",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: LIVE_TRANSCRIBE_MODEL,
                languages: ["en", "ja"],
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 600,
              },
            },
          },
        },
      },
    ]);
  });

  test("retries without languages, then with the fallback model", async () => {
    const { t, caller, room_key } = await room();
    replies = [refused(), refused(), minted()];
    expect(
      await asUser(t, caller).action(api.transcripts.mintAsrToken, {
        room_key,
        languages: ["en"],
      }),
    ).toEqual({
      client_secret: "secret",
      model: FALLBACK_TRANSCRIBE_MODEL,
      languages: [],
    });
    expect(posts.map((p) => p.session.audio.input.transcription)).toEqual([
      { model: LIVE_TRANSCRIBE_MODEL, languages: ["en", "ja"] },
      { model: LIVE_TRANSCRIBE_MODEL },
      { model: FALLBACK_TRANSCRIBE_MODEL },
    ]);
  });

  test("sends nothing for a person outside the room", async () => {
    const { t, outsider, room_key } = await room();
    expect(
      await asUser(t, outsider).action(api.transcripts.mintAsrToken, {
        room_key,
      }),
    ).toEqual({ error: "Not authorized for this room" });
    expect(posts).toEqual([]);
  });
});
