import { expect, test } from "bun:test";
import {
  LIVE_INBOX_LEASE_END,
  rowHeartbeatAliveAt,
} from "@codecast/inbox/inboxProjection";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { useInboxStore, type InboxSession } from "../inboxStore";

const mine = "a".repeat(32);
const teammate = "b".repeat(32);
const first = "c".repeat(32);
const second = "d".repeat(32);
const included = "e".repeat(32);
const outside = "f".repeat(32);
const heartbeat = 500;
const live = {
  liveness_lease_end: LIVE_INBOX_LEASE_END,
  daemon_alive_until: LIVE_INBOX_LEASE_END,
};

function cachedRow(_id: string, fields: Partial<InboxSession>): InboxSession {
  return {
    _id,
    session_id: _id,
    agent_type: "claude_code",
    updated_at: heartbeat,
    message_count: 1,
    ...live,
    ...fields,
  };
}

const cases = [
  {
    scope: "mine",
    owner: mine,
    outsideOwner: teammate,
    teamId: null,
    outsideTeamId: "t1",
  },
  {
    scope: "team",
    owner: teammate,
    outsideOwner: teammate,
    teamId: "t1",
    outsideTeamId: "t2",
  },
] as const;

for (const { scope, owner, outsideOwner, teamId, outsideTeamId } of cases) {
  test(`${scope} snapshots expire omitted cached leases in their scope`, () => {
    const preserved = cachedRow(outside, {
      user_id: outsideOwner,
      team_id: outsideTeamId,
    });
    const original = useInboxStore.getState();
    try {
      useInboxStore.setState({
        sessions: {
          [first]: cachedRow(first, {
            user_id: owner,
            team_id: teamId,
            last_heartbeat: heartbeat,
          }),
          [second]: cachedRow(second, { user_id: owner, team_id: teamId }),
          [included]: cachedRow(included, { user_id: owner, team_id: teamId }),
          [outside]: preserved,
        },
        sessionsProjection: {},
        pending: {},
      });
      useInboxStore
        .getState()
        .applyInboxLivenessPayload(teamId ? `team:${teamId}` : scope, {
          liveness: { [included]: live },
          projection: { scope, user_id: mine, team_id: teamId },
        });

      const { sessions } = useInboxStore.getState();
      expect(sessions[first].liveness_lease_end).toBeNull();
      expect(sessions[first].daemon_alive_until).toBe(
        heartbeat + HEARTBEAT_ALIVE_MS,
      );
      expect(
        rowHeartbeatAliveAt(
          {
            last_heartbeat: sessions[first].last_heartbeat ?? null,
            liveness_lease_end: sessions[first].liveness_lease_end,
          },
          heartbeat + HEARTBEAT_ALIVE_MS,
        ),
      ).toBe(false);
      expect(sessions[second].liveness_lease_end).toBeNull();
      expect(sessions[second].daemon_alive_until).toBeNull();
      expect(sessions[included].liveness_lease_end).toBe(LIVE_INBOX_LEASE_END);
      expect(sessions[outside]).toBe(preserved);
    } finally {
      useInboxStore.setState(original, true);
    }
  });
}
