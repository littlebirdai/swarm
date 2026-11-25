import { testFaker } from "@codecast/test-helpers/faker";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel";
import type { DatabaseWriter } from "../convex/_generated/server";
import { hashToken } from "../convex/apiTokens";

export type NewRow<Table extends TableNames> = Omit<
  Doc<Table>,
  "_id" | "_creationTime"
>;

export function fixtureRows(db: DatabaseWriter, seed: string) {
  const faker = testFaker(seed);
  const date = 1_735_689_600_000;
  const timestamps = { created_at: date, updated_at: date };
  const shortId = (prefix: string) =>
    `${prefix}-${faker.number.int({ min: 1, max: 999_999_999 })}`;

  return {
    user(fields: NewRow<"users"> = {}) {
      return db.insert("users", {
        name: faker.person.fullName(),
        email: faker.internet.email({ provider: "example.com" }),
        ...fields,
      });
    },
    team(fields: Partial<NewRow<"teams">> = {}) {
      return db.insert("teams", {
        name: faker.company.name(),
        invite_code: faker.string.alphanumeric(12),
        created_at: date,
        ...fields,
      });
    },
    membership(
      user: Id<"users">,
      team: Id<"teams">,
      fields: Partial<NewRow<"team_memberships">> = {},
    ) {
      return db.insert("team_memberships", {
        user_id: user,
        team_id: team,
        role: "member",
        joined_at: date,
        ...fields,
      });
    },
    conversation(
      user: Id<"users">,
      fields: Partial<NewRow<"conversations">> = {},
    ) {
      return db.insert("conversations", {
        user_id: user,
        session_id: faker.string.uuid(),
        agent_type: "claude_code",
        started_at: date,
        updated_at: date,
        message_count: 0,
        is_private: false,
        status: "active",
        ...fields,
      });
    },
    message(
      conversation: Id<"conversations">,
      fields: Partial<NewRow<"messages">> = {},
    ) {
      return db.insert("messages", {
        conversation_id: conversation,
        message_uuid: faker.string.uuid(),
        role: "user",
        content: faker.lorem.sentence(),
        timestamp: date,
        ...fields,
      });
    },
    task(user: Id<"users">, fields: Partial<NewRow<"tasks">> = {}) {
      return db.insert("tasks", {
        user_id: user,
        workspace: `user:${user}`,
        short_id: shortId("ct"),
        title: faker.lorem.sentence(),
        task_type: "task",
        status: "open",
        priority: "medium",
        source: "human",
        ...timestamps,
        ...fields,
      });
    },
    plan(user: Id<"users">, fields: Partial<NewRow<"plans">> = {}) {
      return db.insert("plans", {
        user_id: user,
        workspace: `user:${user}`,
        short_id: shortId("pl"),
        title: faker.lorem.sentence(),
        status: "active",
        source: "human",
        ...timestamps,
        ...fields,
      });
    },
    doc(user: Id<"users">, fields: Partial<NewRow<"docs">> = {}) {
      return db.insert("docs", {
        user_id: user,
        workspace: `user:${user}`,
        title: faker.lorem.sentence(),
        content: faker.lorem.paragraph(),
        doc_type: "note",
        source: "human",
        ...timestamps,
        ...fields,
      });
    },
    pullRequest(
      team: Id<"teams">,
      fields: Partial<NewRow<"pull_requests">> = {},
    ) {
      return db.insert("pull_requests", {
        team_id: team,
        github_pr_id: faker.number.int({ min: 1, max: 999_999_999 }),
        repository: `${faker.string.alpha({ length: 8, casing: "lower" })}/${faker.string.alpha({ length: 8, casing: "lower" })}`,
        number: faker.number.int({ min: 1, max: 999_999 }),
        title: faker.lorem.sentence(),
        body: faker.lorem.paragraph(),
        state: "open",
        author_github_username: faker.internet.username(),
        linked_session_ids: [],
        ...timestamps,
        ...fields,
      });
    },
    device(user: Id<"users">, fields: Partial<NewRow<"devices">> = {}) {
      return db.insert("devices", {
        user_id: user,
        device_id: faker.string.uuid(),
        label: faker.word.noun(),
        platform: "darwin",
        last_seen: date,
        ...fields,
      });
    },
    session(
      user: Id<"users">,
      fields: Partial<NewRow<"managed_sessions">> = {},
    ) {
      return db.insert("managed_sessions", {
        user_id: user,
        session_id: faker.string.uuid(),
        pid: faker.number.int({ min: 100, max: 99999 }),
        started_at: date,
        last_heartbeat: date,
        ...fields,
      });
    },
    artifact(
      user: Id<"users">,
      storage: Id<"_storage">,
      fields: Partial<NewRow<"artifacts">> = {},
    ) {
      return db.insert("artifacts", {
        user_id: user,
        storage_id: storage,
        slug: faker.string.alphanumeric(12),
        title: faker.lorem.sentence(),
        version: 1,
        size: 1,
        ...timestamps,
        ...fields,
      });
    },
    async token(user: Id<"users">, token: string) {
      return db.insert("api_tokens", {
        user_id: user,
        token_hash: await hashToken(token),
        name: faker.word.noun(),
        created_at: date,
        last_used_at: date,
      });
    },
  };
}
