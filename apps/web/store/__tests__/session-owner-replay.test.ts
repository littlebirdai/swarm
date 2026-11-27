import { expect, test } from "bun:test";
import { catchUpScope, scopeMetaKey } from "../../hooks/use-sync-change-feed";
import { useInboxStore } from "../inboxStore";
import { webBuilders } from "../../test-helpers/builders";

const CID = "a".repeat(32);

test("replay revokes the personal inbox claim but keeps the team row", async () => {
  const scope = "user:viewer";
  useInboxStore.setState({
    currentUser: { _id: "viewer" },
    sessions: {
      [CID]: webBuilders("session-owner-replay").session.build({
        _id: CID,
        team_id: "team",
        user_id: "runner",
        owner_user_id: "viewer",
        owned_by_me: true,
      }),
    },
    liveInboxIds: new Set([CID]),
    syncMeta: { [scopeMetaKey(scope)]: { cursor: 4 } },
  });
  const replies = [
    {
      actions: [
        {
          position: 5,
          entity_type: "conversations",
          entity_id: CID,
          op: "upsert",
        },
        {
          position: 6,
          entity_type: "session_owner",
          entity_id: `session-owner:${CID}`,
          op: "scope_removed",
        },
      ],
      nextFrom: 6,
      hasMore: false,
    },
    { sessions: [] },
  ];
  await catchUpScope(
    { query: async () => replies.shift() },
    { scope_key: scope, position: 6, floor: 0 },
    new Set(),
  );
  const state = useInboxStore.getState();
  expect(state.sessions[CID]).toMatchObject({
    team_id: "team",
    owned_by_me: false,
    owner_user_id: null,
  });
  expect(state.liveInboxIds.has(CID)).toBe(false);
  expect(state.syncMeta[scopeMetaKey(scope)]?.cursor).toBe(6);
});
