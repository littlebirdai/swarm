import type { api } from "@codecast/convex/convex/_generated/api";
import type { Doc, Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { testFaker } from "@codecast/test-helpers/faker";
import { EMPTY_COUNTS, type OrgRole } from "../../components/org/orgTypes";
import type {
  DocItem,
  InboxSession,
  Message,
  PlanItem,
  ProjectItem,
  TaskItem,
} from "../../store/inboxStore";

type Conversation = Doc<"conversations">;
type TeamMember = NonNullable<
  FunctionReturnType<typeof api.teams.getTeamMembers>[number]
>;

export function webBuilders(seed: string | number) {
  const faker = testFaker(seed);
  const id = () => faker.string.alphanumeric({ length: 32, casing: "lower" });
  const time = () => faker.date.recent().getTime();
  const title = () => faker.company.catchPhrase();

  const session = {
    build(overrides: Partial<InboxSession> = {}): InboxSession {
      const at = time();
      return {
        _id: id(),
        session_id: faker.string.uuid(),
        title: title(),
        started_at: at,
        updated_at: at,
        agent_type: "claude_code",
        message_count: 0,
        is_idle: true,
        has_pending: false,
        ...overrides,
      };
    },
  };
  const conversation = {
    build(overrides: Partial<Conversation> = {}): Conversation {
      const at = time();
      return {
        _id: id() as Id<"conversations">,
        _creationTime: at,
        user_id: id() as Id<"users">,
        agent_type: "claude_code",
        session_id: faker.string.uuid(),
        title: title(),
        started_at: at,
        updated_at: at,
        message_count: 0,
        is_private: true,
        status: "active",
        ...overrides,
      };
    },
  };
  const message = {
    build(overrides: Partial<Message> = {}): Message {
      return {
        _id: id(),
        role: "user",
        content: faker.lorem.sentence(),
        timestamp: time(),
        ...overrides,
      };
    },
  };
  const task = {
    build(overrides: Partial<TaskItem> = {}): TaskItem {
      const at = time();
      return {
        _id: id(),
        short_id: `ct-${faker.number.int({ min: 1, max: 99999 })}`,
        title: title(),
        task_type: "task",
        status: "open",
        priority: "medium",
        source: "human",
        created_at: at,
        updated_at: at,
        ...overrides,
      };
    },
  };
  const plan = {
    build(overrides: Partial<PlanItem> = {}): PlanItem {
      const at = time();
      return {
        _id: id(),
        short_id: `pl-${faker.number.int({ min: 1, max: 99999 })}`,
        title: title(),
        status: "active",
        source: "human",
        created_at: at,
        updated_at: at,
        ...overrides,
      };
    },
  };
  const doc = {
    build(overrides: Partial<DocItem> = {}): DocItem {
      const at = time();
      return {
        _id: id(),
        title: title(),
        content: faker.lorem.paragraph(),
        doc_type: "note",
        source: "human",
        created_at: at,
        updated_at: at,
        ...overrides,
      };
    },
  };
  const teamMember = {
    build(overrides: Partial<TeamMember> = {}): TeamMember {
      return {
        _id: id() as Id<"users">,
        name: faker.person.fullName(),
        email: faker.internet.email({ provider: "example.test" }),
        image: undefined,
        is_bot: false,
        bot_kind: undefined,
        role: "member",
        takes_decisions: true,
        focus_project_ids: [],
        daemon_last_seen: undefined,
        github_username: undefined,
        github_avatar_url: undefined,
        title: undefined,
        bio: undefined,
        status: undefined,
        walkie_pref: undefined,
        walkie_snoozed_until: undefined,
        timezone: undefined,
        presence_state: "offline",
        presence_input_at: undefined,
        in_huddle: false,
        in_room_key: undefined,
        viewing_conversation_id: undefined,
        viewing_since: undefined,
        seat: undefined,
        walkie_joined_at: undefined,
        ...overrides,
      };
    },
  };
  const role = {
    build(overrides: Partial<OrgRole> = {}): OrgRole {
      const at = time();
      const host = overrides.host_user_id ?? id();
      return {
        _id: id(),
        short_id: `ro-${faker.number.int({ min: 1, max: 99999 })}`,
        name: faker.person.jobTitle(),
        handle: faker.word.noun() + "-" + faker.word.noun(),
        host_user_id: host,
        scope_type: "user",
        scope_user_id: host,
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "user", user_id: host },
        status: "active",
        created_by: host,
        created_at: at,
        updated_at: at,
        counts: { ...EMPTY_COUNTS },
        sessions: [],
        total: 0,
        scope_names: { projects: [], plans: [] },
        ...overrides,
      };
    },
  };
  const project = {
    build(overrides: Partial<ProjectItem> = {}): ProjectItem {
      const at = time();
      return {
        _id: id(),
        short_id: `pj-${faker.number.int({ min: 1, max: 99999 })}`,
        title: title(),
        status: "active",
        created_at: at,
        updated_at: at,
        ...overrides,
      };
    },
  };

  return {
    session,
    conversation,
    message,
    task,
    plan,
    doc,
    teamMember,
    role,
    project,
  };
}
