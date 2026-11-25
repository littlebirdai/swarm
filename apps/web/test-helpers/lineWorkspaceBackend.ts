import { api } from "@codecast/convex/convex/_generated/api";
import { pending, type testConvex } from "./testConvex";

export function holdLineWorkspaceFeeds(backend: ReturnType<typeof testConvex>) {
  backend.set(api.lineTrial.cards, pending);
  backend.set(api.lineTrial.projects, pending);
  backend.set(api.lineTrial.runs, pending);
  backend.set(api.lineWorkspace.cards, pending);
  backend.set(api.lineWorkspace.deploys, pending);
  backend.set(api.lineWorkspace.labels, pending);
  backend.set(api.lineWorkspace.occurrences, pending);
  backend.set(api.org.roles, pending);
  backend.set(api.org.tree, pending);
  backend.set(api.projects.webList, pending);
  backend.set(api.sessionDecisions.listOpenForLines, pending);
  backend.set(api.signals.webList, pending);
  backend.set(api.workflow_runs.listRuns, pending);
  backend.set(api.workflows.webGetBySlug, pending);
  backend.set(api.workflows.webList, pending);
  backend.set(api.workflows.webPool, pending);
}
