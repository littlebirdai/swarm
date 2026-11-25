import { describe, expect, it } from "bun:test";
import { deriveLiveAt } from "../src/inboxProjection";
import {
  HEARTBEAT_ALIVE_MS,
  HEARTBEAT_FLUSH_INTERVAL_MS,
  HEARTBEAT_REFRESH_MS,
  HEARTBEAT_WRITE_CADENCE_MS,
} from "@codecast/sessions/agentStatus";

const NOW = 1_000_000_000_000;

describe("heartbeat liveness window", () => {
  it("is derived from the cadence it measures", () => {
    expect(HEARTBEAT_WRITE_CADENCE_MS).toBe(
      HEARTBEAT_REFRESH_MS + HEARTBEAT_FLUSH_INTERVAL_MS,
    );
  });

  it("clears the write cadence by a whole extra flush", () => {
    expect(HEARTBEAT_ALIVE_MS - HEARTBEAT_WRITE_CADENCE_MS).toBeGreaterThan(
      HEARTBEAT_FLUSH_INTERVAL_MS,
    );
  });

  const quietWorkingSession = (heartbeatAge: number) =>
    deriveLiveAt(
      {
        status: "active",
        updated_at: NOW - 5 * 60_000,
        message_count: 2668,
        has_pending_messages: false,
        agent_status: "working",
        agent_status_updated_at: NOW - 5 * 60_000,
        last_heartbeat: NOW - heartbeatAge,
        daemon_alive_until: NOW - heartbeatAge + HEARTBEAT_ALIVE_MS,
        last_role_is_user: false,
      } as any,
      NOW,
    );

  it("keeps a quiet working session alive across a late flush", () => {
    expect(quietWorkingSession(85_000).agent_status).toBe("working");
    expect(quietWorkingSession(95_000).agent_status).toBe("working");
  });

  it("still calls a genuinely gone daemon stopped", () => {
    expect(quietWorkingSession(10 * 60_000).agent_status).toBe("stopped");
  });
});
