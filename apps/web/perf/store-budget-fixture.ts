import type { Message } from "../store/inboxStore";

export const id = (index: number) => `j${String(index).padStart(31, "0")}`;
export const now = Date.now();
export const session = (index: number) => ({
  _id: id(index),
  session_id: `session-${index}`,
  title: "Budget session",
  updated_at: now - index,
});

export const budgetMessages = (conversation: number): Message[] =>
  Array.from({ length: 250 }, (_, index) => ({
    _id: `message-${index}`,
    timestamp: index + 1,
    role: "assistant",
    content: `Résumé ${conversation} ${index} ${"word ".repeat(76)}`,
    ...(index === 100
      ? {
          images: [
            {
              data: "a".repeat(128 * 1024),
              media_type: "image/png",
              ...(conversation % 4 ? { storage_id: id(conversation) } : {}),
            },
          ],
        }
      : {}),
  }));

export const fixtureSizes = {
  sessions: 1300,
  conversations: 1300,
  docDetails: 220,
  taskComments: 1600,
  pullRequestDetails: 24,
  deployReach: 320,
  runGraphs: 60,
  deployDetails: 70,
  externalEvents: 2100,
  settingsData: 2,
  mySends: 10100,
} as const;

export const retainedRows = (key: string, size: number) =>
  Array.from({ length: size }, (_, index) => ({
    ...session(index),
    _cachedAt: now - index,
    timestamp: now - index,
    ...(key === "taskComments" ? { comments: [] } : {}),
    ...(key === "settingsData"
      ? { _id: index === 0 ? "team:preferences" : "team:teamMembers" }
      : {}),
  }));

export const budgetTail = (): Message[] =>
  Array.from({ length: 200 }, (_, index) => ({
    _id: `message-${index}`,
    timestamp: index + 1,
    role: "assistant",
    content: `Message ${index}`,
  }));

export const calibratedDocRows = (count = 1000) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `d${String(index).padStart(31, "0")}`,
    _creationTime: now - index,
    title: `Design note ${index}`,
    display_title: `Design note ${index}`,
    doc_type: "note",
    project_id: `p${String(index % 20).padStart(31, "0")}`,
    user_id: id(1),
    team_id: id(2),
    workspace: `team:${id(2)}`,
    created_at: now - index,
    updated_at: now - index,
    labels: ["perf"],
    client_key: `doc-${index}`,
    content: "Body line ".repeat(800),
    entries: [{ id: `entry-${index}`, text: "Entry ".repeat(20) }],
    embedding: Array.from({ length: 64 }, () => 0.125),
  }));

export const calibratedDocDetailRows = (count = 220) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `d${String(index).padStart(31, "0")}`,
    _creationTime: now - index,
    title: `Design note ${index}`,
    updated_at: now - index,
    _cachedAt: now - index,
    content: "Body line ".repeat(800),
    embedding: Array.from({ length: 64 }, () => 0.125),
  }));

export const calibratedSessionRows = (count = 1300) =>
  Array.from({ length: count }, (_, index) => ({
    ...session(index),
    bucket: "active",
    work_state: "working",
    asking: false,
    below_fold: false,
    bucket_stale_at: now - index,
    stale_bucket: "active",
  }));

export const calibratedConversationRows = (count = 1200) =>
  Array.from({ length: count }, (_, index) => ({
    ...session(index),
    created_at: now - index,
    status: "active",
    team_id: id(2),
    directory: "/repo/app",
    git_branch: "main",
    model: "claude-opus-4-8",
  }));

export const calibratedExternalEventRows = (count = 2000) =>
  Array.from({ length: count }, (_, index) => ({
    _id: id(index),
    team_id: id(2),
    source: "github",
    repository: "acme/app",
    kind: "pr_opened",
    actor_login: "alice",
    title: `Pull request event ${String(index).padStart(4, "0")}`,
    summary: "Updated build pipeline checks",
    url: "https://github.com/acme/app/pull/42",
    sha: "abcdef1234567890",
    branch: "main",
    pr_number: 42,
    created_at: now - index,
  }));

export const calibratedMySendRows = (count = 10000) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `ms:${id(index)}`,
    message_id: id(index),
    conversation_id: id(index % 400),
    session_title: "Budget session",
    project: "app",
    timestamp: now - index,
    words: 12,
    text: `Prompt ${String(index).padStart(5, "0")} review recent workspace changes`,
    clipped: false,
  }));

export const calibratedDeployReachRows = (count = 320) =>
  Array.from({ length: count }, (_, index) => {
    const ref = `acme/app#${String(index).padStart(4, "0")}`;
    return {
      _id: ref,
      ref,
      state: "live",
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      targets: [
        {
          target: "web",
          state: "live",
          deploy: "dp-1234",
          now: now - index,
        },
      ],
      _cachedAt: now - index,
    };
  });

export const calibratedRunGraphRows = (count = 60) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `ver-${String(index).padStart(3, "0")}`,
    workflow_id: id(index % 10),
    name: "change",
    nodes: Array.from({ length: 6 }, (_, node) => ({
      id: `n${node}`,
      label: `Step ${node}`,
      kind: "agent",
    })),
    edges: Array.from({ length: 5 }, (_, edge) => ({
      from: `n${edge}`,
      to: `n${edge + 1}`,
    })),
    _cachedAt: now - index,
  }));

export const calibratedDeployDetailRows = (count = 70) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `dep-${String(index).padStart(3, "0")}`,
    short_id: `dp-${String(index).padStart(3, "0")}`,
    sha: "abcdef1234567890",
    commits: Array.from({ length: 10 }, (_, commit) => ({
      sha: `commit-${commit}`,
      message: "Deploy commit message",
    })),
    carries: ["commit-0", "commit-1"],
    adds: Array.from(
      { length: 20 },
      (_, add) => `fn:addedFunction${String(add).padStart(2, "0")}`,
    ),
    drops: Array.from(
      { length: 5 },
      (_, drop) => `fn:droppedFunction${String(drop).padStart(2, "0")}`,
    ),
  }));

export const calibratedSettingsDataRows = () => [
  {
    _id: `${id(1)}:${id(2)}:team`,
    value: {
      _id: id(2),
      name: "Acme",
      slug: "acme",
      default_model: "claude-opus-4-8",
    },
  },
  {
    _id: `${id(1)}:${id(2)}:githubInstallations`,
    value: [{ _id: "inst-1", account_login: "acme", repository_count: 12 }],
  },
  {
    _id: `${id(1)}:user:directoryMappings`,
    value: [{ _id: "map-1", path_prefix: "/src/acme", repository: "acme/app" }],
  },
  {
    _id: `${id(1)}:user:accountProfiles`,
    value: {
      devices: [{ device_id: "mac-studio", label: "Workstation" }],
    },
  },
];
