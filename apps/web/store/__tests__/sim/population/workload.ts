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
    | "docs",
>(table: Table, index: number): Id<Table> {
  return `${table.replaceAll("_", "")}${index.toString(36).padStart(5, "0")}`.padEnd(
    32,
    "0",
  ) as Id<Table>;
}

export function populationTables(
  model: ReturnType<typeof population>,
  at: number,
) {
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
  return {
    users: model.people.map(({ id }) => ({
      _id: fixtureId("users", id),
      _creationTime: at,
      name: `Person ${id}`,
    })),
    teams: [{ _id: team, _creationTime: at, name: "Simulation team" }],
    team_memberships: model.people.map(({ id }) => ({
      _id: fixtureId("team_memberships", id),
      _creationTime: at,
      user_id: fixtureId("users", id),
      team_id: team,
      role: "member",
      joined_at: at,
      visibility: "full",
    })),
    projects: model.projects.map((id): Doc<"projects"> => ({
      _id: fixtureId("projects", id),
      _creationTime: at,
      ...projectScope(id),
      title: `Project ${id}`,
      status: "active",
      created_at: at,
      updated_at: at,
    })),
    docs: model.projects.map((id): Doc<"docs"> => ({
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
    })),
    conversations: model.sessions.map(({ id, owner, active }) => ({
      _id: fixtureId("conversations", id),
      _creationTime: at,
      session_id: String(fixtureId("conversations", id)),
      user_id: fixtureId("users", owner),
      team_id: team,
      is_private: false,
      team_visibility: "full",
      status: active ? "active" : "completed",
      title: `Session ${id}`,
      skip_title_generation: true,
      agent_type: "claude_code",
      message_count: 0,
      started_at: at,
      updated_at: at,
    })),
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
): Promise<string> {
  if (shortId) {
    await client.mutation("tasks:webUpdate", {
      short_id: shortId,
      title: `Verify the project changes from agent ${event.agent}`,
    });
    return shortId;
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
