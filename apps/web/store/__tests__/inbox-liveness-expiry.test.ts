import { expect, test } from "bun:test";
import {
  LIVE_INBOX_LEASE_END,
  rowHeartbeatAliveAt,
  WORKING_SET_RECENCY_MS,
  type InboxTruncation,
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
const epoch = WORKING_SET_RECENCY_MS + 600_000;
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
    is_idle: true,
    has_pending: false,
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
    outsideOwner: mine,
    teamId: "t1",
    outsideTeamId: "t1",
  },
] as const;

for (const { scope, owner, outsideOwner, teamId, outsideTeamId } of cases) {
  test(`${scope} snapshots expire omitted cached leases in their scope`, () => {
    const preserved = cachedRow(outside, {
      user_id: outsideOwner,
      team_id: outsideTeamId,
      is_subagent: true,
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

const omissionCases: {
  name: string;
  truncated: InboxTruncation[];
  fields?: Partial<InboxSession>;
  parent?: Partial<InboxSession>;
  grace?: boolean;
  team?: boolean;
}[] = [
  { name: "recent window", truncated: ["recent"], grace: true },
  {
    name: "pinned window",
    truncated: ["pinned"],
    fields: { inbox_pinned_at: heartbeat },
    grace: true,
  },
  {
    name: "adopted window",
    truncated: ["adopted"],
    fields: {
      is_subagent: true,
      parent_conversation_id: included,
      inbox_adopted_at: epoch - 10,
    },
    grace: true,
  },
  {
    name: "subagent window",
    truncated: ["subagents"],
    fields: { is_subagent: true, parent_conversation_id: included },
    grace: true,
  },
  { name: "team member cap", truncated: ["members"], team: true, grace: true },
  {
    name: "team member row cap",
    truncated: ["member_rows"],
    team: true,
    grace: true,
  },
  {
    name: "expiry after a later heartbeat",
    truncated: ["recent"],
    fields: { last_heartbeat: epoch + 30_000 },
    grace: true,
  },
  { name: "no truncation", truncated: [] },
  {
    name: "personal cap on a team snapshot",
    truncated: ["recent"],
    team: true,
  },
  {
    name: "a parent beyond the personal pinned cap",
    truncated: ["pinned"],
    fields: { is_subagent: true, parent_conversation_id: second },
    parent: { inbox_pinned_at: heartbeat },
    grace: true,
  },
  {
    name: "a parent beyond the team member cap",
    truncated: ["members"],
    fields: { is_subagent: true, parent_conversation_id: second },
    parent: {},
    team: true,
    grace: true,
  },
  {
    name: "a personal session reassigned away",
    truncated: [],
    fields: { owner_user_id: teammate },
  },
  { name: "unrelated window", truncated: ["pinned"] },
  {
    name: "out of the recent window",
    truncated: ["recent"],
    fields: { updated_at: heartbeat },
  },
  {
    name: "killed row",
    truncated: ["pinned"],
    fields: { inbox_killed_at: heartbeat, inbox_pinned_at: heartbeat },
  },
  {
    name: "archived row",
    truncated: ["pinned"],
    fields: { status: "archived", inbox_pinned_at: heartbeat },
  },
];

for (const { name, truncated, fields, parent, grace, team } of omissionCases) {
  test(`an omitted cached lease gets the right deadline for ${name}`, () => {
    const original = useInboxStore.getState();
    const row = cachedRow(first, {
      user_id: team ? teammate : mine,
      team_id: team ? "t1" : null,
      last_heartbeat: heartbeat,
      updated_at: epoch - 10,
      ...fields,
    });
    const scopeKey = team ? "team:t1" : "mine";
    const snapshot = {
      liveness: { [included]: live },
      projection: {
        scope: team ? "team" : "mine",
        user_id: mine,
        team_id: team ? "t1" : null,
        epoch,
        truncated,
      },
    };
    try {
      useInboxStore.setState({
        sessions: {
          [first]: row,
          ...(parent && {
            [second]: cachedRow(second, {
              user_id: row.user_id,
              team_id: row.team_id,
              updated_at: epoch - 20,
              ...parent,
            }),
          }),
        },
        sessionsProjection: {},
        pending: {},
      });
      useInboxStore.getState().applyInboxLivenessPayload(scopeKey, snapshot);
      const next = useInboxStore.getState().sessions[first];
      const lastHeartbeat = row.last_heartbeat ?? null;
      const expectedEnd =
        Math.max(lastHeartbeat ?? 0, grace ? epoch : 0) + HEARTBEAT_ALIVE_MS;
      expect(next.liveness_lease_end).toBe(grace ? expectedEnd : null);
      expect(next.daemon_alive_until).toBe(expectedEnd);
      const facts = {
        liveness_lease_end: next.liveness_lease_end,
        last_heartbeat: next.last_heartbeat ?? null,
      };
      expect(rowHeartbeatAliveAt(facts, expectedEnd - 1)).toBe(true);
      expect(rowHeartbeatAliveAt(facts, expectedEnd)).toBe(false);
      useInboxStore.getState().applyInboxLivenessPayload(scopeKey, {
        ...snapshot,
        projection: { ...snapshot.projection, epoch: epoch + 60_000 },
      });
      expect(useInboxStore.getState().sessions[first]).toBe(next);
    } finally {
      useInboxStore.setState(original, true);
    }
  });
}
