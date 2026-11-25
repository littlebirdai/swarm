import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("Code is reachable from the main rail and command menu", () => {
  expect(read("components/sidebar/SidebarNav.tsx")).toMatch(
    /label="Code"\s+href="\/repo"/,
  );
  expect(read("lib/navPages.ts")).toMatch(/label: "Code",\s*path: "\/repo"/);
  expect(read("components/CommandPalette.tsx")).toContain("palettePages");
  expect(read("components/CommandPalette.tsx")).toContain(
    "<RepositoryPaletteItems",
  );
});

test("session branch opens the internal browser and object pages expose related code", () => {
  for (const file of [
    "components/conversation-view.tsx",
    "components/inbox/SessionCardView.tsx",
  ])
    expect(read(file)).toMatch(/<BranchCodeLink\s+session=/);
  for (const file of [
    "app/tasks/[id]/page.tsx",
    "app/plans/[id]/page.tsx",
    "components/PlanDetailPanel.tsx",
  ])
    expect(read(file)).toMatch(/<RepositoryLinks\s/);
  expect(read("components/conversation-view.tsx")).not.toContain(
    "window.open(`https://github.com/${match[1]}/tree/",
  );
  expect(read("components/conversation-view.tsx")).toContain(
    "const codeRouter = useRouter();",
  );
  expect(read("components/conversation-view.tsx")).toMatch(
    /codeRouter\.push\(\s*repoTreeHref\(/,
  );
  expect(read("components/conversation-view.tsx")).toMatch(
    /codeRouter\.push\(\s*repoCommitsHref\(/,
  );
});

test("main and nested session projections carry the repository origin", () => {
  const convex = readFileSync(
    new URL("../../../../apps/server/convex/conversations.ts", import.meta.url),
    "utf8",
  );
  expect(convex).toContain("git_remote_url: conv.git_remote_url,");
  expect(convex).toContain("git_remote_url: child.git_remote_url,");
  expect(read("store/inboxStore.ts")).toContain('s.git_remote_url || ""');
});

test("plan code links are visible without opening its Info panel", () => {
  const page = read("app/plans/[id]/page.tsx");
  const lead = page.slice(
    page.indexOf("leadContent={"),
    page.indexOf("topBarLeft={"),
  );
  expect(lead).toMatch(/<RepositoryLinks\s+planId=\{plan\._id\}/);
  expect(page.match(/<RepositoryLinks\s/g)).toHaveLength(1);
});
