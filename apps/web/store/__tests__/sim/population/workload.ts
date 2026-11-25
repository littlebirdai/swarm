import { v } from "convex/values";
import { internalMutation } from "@codecast/convex/convex/functions";
import type { Doc, Id } from "@codecast/convex/convex/_generated/dataModel";
import type { population } from "./model";

export function fixtureId<
  Table extends "users" | "teams" | "projects" | "team_memberships",
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
  return {
    users: model.people.map(({ id }) => ({
      _id: fixtureId("users", id),
      _creationTime: at,
      name: `Person ${id}`,
    })),
    teams: model.teams.map(({ id }) => ({
      _id: fixtureId("teams", id),
      _creationTime: at,
      name: `Team ${id}`,
    })),
    team_memberships: model.people.map(({ id, team }) => ({
      _id: fixtureId("team_memberships", id),
      _creationTime: at,
      user_id: fixtureId("users", id),
      team_id: fixtureId("teams", team),
      role: "member",
      joined_at: at,
      visibility: "full",
    })),
    projects: model.projects.map(({ team }, id): Doc<"projects"> => ({
      _id: fixtureId("projects", id),
      _creationTime: at,
      user_id: fixtureId("users", model.teams[team].members[0]),
      team_id: fixtureId("teams", team),
      workspace: `team:${fixtureId("teams", team)}`,
      title: `Project ${id}`,
      status: "active",
      created_at: at,
      updated_at: at,
    })),
  };
}

export const saveTask = internalMutation({
  args: {
    task: v.optional(v.id("tasks")),
    user: v.id("users"),
    team: v.id("teams"),
    project: v.id("projects"),
    agent: v.number(),
    privateTask: v.boolean(),
  },
  handler: async (ctx, { task, user, team, project, agent, privateTask }) => {
    const at = Date.now();
    if (task) {
      await ctx.db.patch(task, {
        title: `Verify the project changes from agent ${agent}`,
        updated_at: at,
      });
      return task;
    }
    return ctx.db.insert("tasks", {
      user_id: user,
      team_id: team,
      workspace: privateTask ? `user:${user}` : `team:${team}`,
      project_id: project,
      short_id: `ct-${agent + 1}`,
      title: `Review the project changes from agent ${agent}`,
      description: "Run the project checks and record the result in the task.",
      task_type: "task",
      source: "agent",
      status: "in_progress",
      priority: "medium",
      created_at: at,
      updated_at: at,
    });
  },
});
