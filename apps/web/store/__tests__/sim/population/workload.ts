import { computeWorkspaceKey } from "@codecast/convex/convex/lib/accessKeys";
import type { Doc, Id } from "@codecast/convex/convex/_generated/dataModel";
import type { SimClient } from "@codecast/convex/convex/simBackend.testing";
import type { Activity, BackgroundActivity, population } from "./model";

export function fixtureId<
  Table extends
    | "users"
    | "teams"
    | "projects"
    | "team_memberships"
    | "conversations"
    | "managed_sessions"
    | "docs"
    | "tasks",
>(table: Table, index: number): Id<Table> {
  return `${table.replaceAll("_", "")}${index.toString(36).padStart(5, "0")}`.padEnd(
    32,
    "0",
  ) as Id<Table>;
}

export function populationTables(
  model: ReturnType<typeof population>,
  at: number,
  options?: { realistic?: boolean; includeConversationAccess?: boolean },
) {
  const realistic = !!options?.realistic;
  const multiTeam = realistic && model.people.length >= 2;
  const team = fixtureId("teams", 0);
  const projectOwners = model.projects.map(
    (project) =>
      model.people.find(({ follows }) => follows[0] === project)?.id ?? project,
  );
  const projectScope = (project: number) => {
    const owner = {
      user_id: fixtureId("users", projectOwners[project]),
      team_id: team,
    };
    return { ...owner, workspace: computeWorkspaceKey(owner, null) };
  };
  const users: any[] = model.people.map(({ id }) => ({
    _id: fixtureId("users", id),
    _creationTime: at,
    name: `Person ${id}`,
  }));
  const teams: any[] = [
    { _id: team, _creationTime: at, name: "Simulation team" },
  ];
  const memberships: any[] = model.people.map(({ id }) => ({
    _id: fixtureId("team_memberships", id),
    _creationTime: at,
    user_id: fixtureId("users", id),
    team_id: team,
    role: "member",
    joined_at: at,
    visibility: "full",
  }));
  const projects: Doc<"projects">[] = model.projects.map((id) => ({
    _id: fixtureId("projects", id),
    _creationTime: at,
    ...projectScope(id),
    title: `Project ${id}`,
    status: "active",
    created_at: at,
    updated_at: at,
  }));
  const docs: Doc<"docs">[] = model.projects.map((id) => ({
    _id: fixtureId("docs", id),
    _creationTime: at,
    ...projectScope(id),
    project_id: fixtureId("projects", id),
    title: `Project ${id} notes`,
    content: "Project progress",
    doc_type: "note",
    source: "human",
    created_at: at,
    updated_at: at,
  }));
  const conversations: any[] = model.sessions.map(({ id, owner, active }) => ({
    _id: fixtureId("conversations", id),
    _creationTime: at,
    session_id: String(fixtureId("conversations", id)),
    user_id: fixtureId("users", owner),
    team_id: team,
    is_private: realistic ? !active : false,
    team_visibility: realistic && !active ? "private" : "full",
    status: active ? "active" : "completed",
    title: `Session ${id}`,
    skip_title_generation: true,
    agent_type: "claude_code",
    message_count: 0,
    started_at: at,
    updated_at: at,
  }));
  const tasks: any[] = [];

  if (multiTeam) {
    const extIndex = model.people.length;
    const extUser = fixtureId("users", extIndex);
    const extTeam = fixtureId("teams", 1);
    const extProj = fixtureId("projects", model.projects.length);
    const extConv = fixtureId("conversations", model.sessions.length);
    users.push({ _id: extUser, _creationTime: at, name: "External Member" });
    teams.push({ _id: extTeam, _creationTime: at, name: "External team" });
    memberships.push({
      _id: fixtureId("team_memberships", extIndex),
      _creationTime: at,
      user_id: extUser,
      team_id: extTeam,
      role: "member",
      joined_at: at,
      visibility: "full",
    });
    projects.push({
      _id: extProj,
      _creationTime: at,
      user_id: extUser,
      team_id: extTeam,
      workspace: `team:${extTeam}`,
      title: "External Project",
      status: "active",
      created_at: at,
      updated_at: at,
    });
    docs.push({
      _id: fixtureId("docs", model.projects.length),
      _creationTime: at,
      user_id: extUser,
      team_id: extTeam,
      workspace: `team:${extTeam}`,
      project_id: extProj,
      title: "External notes",
      content: "External progress",
      doc_type: "note",
      source: "human",
      created_at: at,
      updated_at: at,
    });
    conversations.push({
      _id: extConv,
      _creationTime: at,
      session_id: String(extConv),
      user_id: extUser,
      team_id: extTeam,
      is_private: false,
      team_visibility: "full",
      status: "active",
      title: "External session",
      skip_title_generation: true,
      agent_type: "claude_code",
      message_count: 0,
      started_at: at,
      updated_at: at,
    });
    tasks.push({
      _id: fixtureId("tasks", 0),
      _creationTime: at,
      user_id: extUser,
      team_id: extTeam,
      workspace: `team:${extTeam}`,
      home_scope: `project:${extProj}`,
      project_id: extProj,
      short_id: "ct-900001",
      title: "External team task",
      task_type: "task",
      status: "open",
      priority: "medium",
      source: "human",
      created_at: at,
      updated_at: at,
    });
    tasks.push({
      _id: fixtureId("tasks", 1),
      _creationTime: at,
      user_id: extUser,
      team_id: team,
      workspace: `user:${extUser}`,
      home_scope: `project:${fixtureId("projects", 0)}`,
      project_id: fixtureId("projects", 0),
      short_id: "ct-900002",
      title: "Private in team task",
      task_type: "task",
      status: "open",
      priority: "medium",
      source: "human",
      created_at: at,
      updated_at: at,
    });
  }

  const conversation_access = options?.includeConversationAccess
    ? conversations.map((conv, index) => ({
        _id: `popconvacc${index.toString(36).padStart(5, "0")}`.padEnd(32, "0"),
        _creationTime: at,
        conversation_id: conv._id,
        user_id: conv.user_id,
        team_id: conv.team_id,
        is_private: conv.is_private,
        team_visibility: conv.team_visibility,
        started_at: conv.started_at,
      }))
    : [];

  return {
    users,
    teams,
    team_memberships: memberships,
    projects,
    docs,
    conversations,
    ...(options?.includeConversationAccess ? { conversation_access } : {}),
    tasks,
    managed_sessions: model.sessions
      .filter(({ active }) => active)
      .map(({ id, owner }) => ({
        _id: fixtureId("managed_sessions", id),
        _creationTime: at,
        session_id: String(fixtureId("conversations", id)),
        conversation_id: fixtureId("conversations", id),
        user_id: fixtureId("users", owner),
        pid: id + 1,
        started_at: at,
        last_heartbeat: at - 30_000,
        agent_status: "working",
      })),
  };
}

export async function saveTask(
  client: SimClient,
  event: Activity,
  shortId?: string,
  options?: {
    realistic?: boolean;
    apiToken?: string;
    nextProject?: number;
  },
): Promise<string> {
  if (shortId) {
    await client.mutation("tasks:webUpdate", {
      short_id: shortId,
      title: `Verify the project changes from agent ${event.agent}`,
      ...(options?.nextProject !== undefined
        ? { project_id: String(fixtureId("projects", options.nextProject)) }
        : {}),
    });
    return shortId;
  }
  const sessionLinked =
    !!options?.realistic && !event.privateTask && event.agent % 4 === 1;
  if (sessionLinked && options?.apiToken) {
    const task = await client.mutation("tasks:create", {
      api_token: options.apiToken,
      workspace: "team",
      team_id: fixtureId("teams", 0),
      conversation_id: String(fixtureId("conversations", event.person.id * 2)),
      title: `Review session changes from agent ${event.agent}`,
      description: "Check the session output and record the result.",
      status: "in_progress",
    });
    return task.short_id;
  }
  if (options?.realistic && event.privateTask && options?.apiToken) {
    const task = await client.mutation("tasks:create", {
      api_token: options.apiToken,
      conversation_id: String(
        fixtureId("conversations", event.person.id * 2 + 1),
      ),
      title: `Private notes from agent ${event.agent}`,
      description: "Track private verification details for the owner only.",
      status: "in_progress",
    });
    return task.short_id;
  }
  const task = await client.mutation("tasks:webCreate", {
    ...(event.privateTask
      ? { workspace: "personal" }
      : {
          workspace: "team",
          team_id: fixtureId("teams", 0),
          project_id: fixtureId("projects", event.project),
        }),
    title: `Review the project changes from agent ${event.agent}`,
    description: "Run the project checks and record the result in the task.",
    status: "in_progress",
  });
  return task.short_id;
}

export async function runBackground(
  client: SimClient,
  event: BackgroundActivity,
) {
  if (event.kind === "doc") {
    await client.mutation("docs:webUpdate", {
      id: fixtureId("docs", event.project),
      title: `Project ${event.project} notes at ${event.at}`,
      content: `Project progress reported by member ${event.person.id}`,
    });
    return;
  }
  const conversation_id = fixtureId("conversations", event.session.id);
  if (event.kind === "heartbeat") {
    const result = await client.mutation("managedSessions:heartbeat", {
      session_id: String(conversation_id),
    });
    if (!result.found) throw new Error(`Missing session ${conversation_id}`);
    return;
  }
  const timestamp = Date.now();
  const result = await client.mutation("messages:addMessages", {
    conversation_id,
    messages: [
      {
        message_uuid: `population-${event.at}-prompt`,
        role: "user",
        timestamp,
        content: `Check the project changes for revision ${event.at} and report what remains.`,
      },
      {
        message_uuid: `population-${event.at}-reply`,
        role: "assistant",
        timestamp: timestamp + 1,
        content: `The checks for revision ${event.at} passed. The next change is ready to review.`,
      },
    ],
  });
  if (result.inserted !== 2)
    throw new Error(`Transcript batch was not appended for ${conversation_id}`);
}
