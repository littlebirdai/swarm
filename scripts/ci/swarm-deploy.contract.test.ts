import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../..");
const workflowFile = "deploy-swarm-backend.yml";
const script = "scripts/deploy-backend.sh";
const deployment = readFileSync(
  join(root, "scripts/swarm-production-deployment.txt"),
  "utf8",
).trim();
const sha = "a".repeat(40);
const ci: Record<string, string> = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: "littlebirdai/swarm",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: `littlebirdai/swarm/.github/workflows/${workflowFile}@refs/heads/main`,
  GITHUB_SHA: sha,
  CONVEX_DEPLOY_KEY: `prod:${deployment}|fake-test-value`,
};

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}, args: string[] = []) {
  dir = mkdtempSync(join(tmpdir(), "swarm-deploy-"));
  const trace = join(dir, "trace");
  const files: Record<string, string> = {
    [script]: readFileSync(join(root, script), "utf8"),
    "scripts/swarm-production-deployment.txt": deployment,
    "bin/git": `#!/bin/bash
set -eu
case "$*" in
  "-C "*"--show-toplevel") printf '%s\\n' "$FAKE_ROOT" ;;
  "rev-parse HEAD") printf '%s\\n' "$FAKE_HEAD" ;;
  "status --porcelain") printf '%s' "\${FAKE_STATUS:-}" ;;
  "ls-remote --exit-code https://github.com/littlebirdai/swarm.git refs/heads/main")
    printf 'remote\\n' >> "$FAKE_TRACE"
    [ "\${FAKE_MAIN:-}" != unavailable ] || exit 1
    case "\${FAKE_MAIN:-}" in
      advances)
        if /usr/bin/grep -q '^gate$' "$FAKE_TRACE"; then
          printf '%s\\trefs/heads/main\\n' "\${FAKE_HEAD/a/b}"
          exit
        fi ;;
      ?*) printf '%s\\trefs/heads/main\\n' "$FAKE_MAIN"; exit ;;
    esac
    printf '%s\\trefs/heads/main\\n' "$FAKE_HEAD" ;;
  "show $FAKE_HEAD:scripts/swarm-production-drops.json")
    printf '%s\\n' "$FAKE_COMMITTED_LIST" ;;
  *) exit 97 ;;
esac`,
    "bin/bun": `#!/bin/bash
set -eu
[ "$*" = "--no-env-file apps/server/scripts/prod-diff.ts --swarm-gate ${deployment}" ]
printf 'gate\\n' >> "$FAKE_TRACE"
cat >> "$FAKE_TRACE"
exit "\${FAKE_DIFF_EXIT:-0}"`,
    "node_modules/.bin/convex": `#!/bin/bash
set -eu
[ "$PWD" = "$FAKE_ROOT/apps/server" ]
[ "$CONVEX_DEPLOYMENT$CONVEX_SELF_HOSTED_URL$CONVEX_SELF_HOSTED_ADMIN_KEY$CONVEX_PROVISION_HOST$CONVEX_OVERRIDE_ACCESS_TOKEN" = "" ]
printf 'push %s\\n' "$*" >> "$FAKE_TRACE"`,
    "apps/server/.keep": "",
    "scripts/swarm-production-drops.json":
      '{"table:worktree-only":"ignored by git show"}',
    trace: "",
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    chmodSync(path, 0o700);
  }
  const result = Bun.spawnSync(["/bin/bash", join(dir, script), ...args], {
    cwd: dir,
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      FAKE_ROOT: dir,
      FAKE_HEAD: sha,
      FAKE_TRACE: trace,
      FAKE_COMMITTED_LIST: "{}",
      ...ci,
      ...env,
    },
  });
  return {
    code: result.exitCode,
    err: result.stderr.toString(),
    trace: readFileSync(trace, "utf8"),
  };
}

describe("Swarm production deploy process", () => {
  test.each([
    [
      "on a laptop",
      { CI: "", GITHUB_ACTIONS: "", RUNNER_ENVIRONMENT: "" },
      "GitHub-hosted CI",
      "",
    ],
    [
      "on a self-hosted runner",
      { RUNNER_ENVIRONMENT: "self-hosted" },
      "GitHub-hosted CI",
      "",
    ],
    [
      "from a CI push",
      { GITHUB_EVENT_NAME: "push" },
      "manual Swarm backend workflow",
      "",
    ],
    [
      "from a feature branch",
      { GITHUB_REF: "refs/heads/feature" },
      "manual Swarm backend workflow",
      "",
    ],
    [
      "from another repository",
      { GITHUB_REPOSITORY: "someone/swarm" },
      "manual Swarm backend workflow",
      "",
    ],
    [
      "from another workflow",
      {
        GITHUB_WORKFLOW_REF:
          "littlebirdai/swarm/.github/workflows/ci.yml@refs/heads/main",
      },
      "manual Swarm backend workflow",
      "",
    ],
    [
      "without a key",
      { CONVEX_DEPLOY_KEY: "" },
      "no production deploy key",
      "",
    ],
    [
      "with a key for another deployment",
      { CONVEX_DEPLOY_KEY: "prod:wrong|fake" },
      "not a production key",
      "",
    ],
    [
      "with a self-hosted override",
      { CONVEX_SELF_HOSTED_URL: "https://example.invalid" },
      "server overrides",
      "",
    ],
    [
      "at a different checkout SHA",
      { GITHUB_SHA: "c".repeat(40) },
      "checkout does not match",
      "",
    ],
    [
      "with worktree changes",
      { FAKE_STATUS: " M schema.ts" },
      "uncommitted changes",
      "",
    ],
    [
      "with a stale main snapshot",
      { FAKE_MAIN: "b".repeat(40) },
      "no longer the tip",
      "remote\n",
    ],
    [
      "with unverified main",
      { FAKE_MAIN: "unavailable" },
      "could not verify",
      "remote\n",
    ],
    [
      "when the inventory blocks a drop",
      { FAKE_DIFF_EXIT: "1" },
      "inventory check failed",
      "remote\ngate\n{}\n",
    ],
    [
      "when production inventory is unreadable",
      { FAKE_DIFF_EXIT: "3" },
      "inventory check failed",
      "remote\ngate\n{}\n",
    ],
    [
      "when main advances during the diff",
      { FAKE_MAIN: "advances" },
      "no longer the tip",
      "remote\ngate\n{}\nremote\n",
    ],
  ] as const)("refuses %s before pushing", (_, vars, message, trace) => {
    expect(run(vars)).toEqual({
      code: 1,
      err: expect.stringContaining(message),
      trace,
    });
  });

  test("refuses deploy flags that could change the target", () => {
    expect(run({}, ["--deployment-name", "other"])).toEqual({
      code: 1,
      err: expect.stringContaining("does not accept deploy arguments"),
      trace: "",
    });
  });

  test("passes the committed allowlist to the gate before pushing the approved commit", () => {
    expect(
      run({
        FAKE_COMMITTED_LIST: '{"table:reviewed":"migration completed"}',
        CONVEX_DEPLOYMENT: "dev:unrelated",
      }),
    ).toEqual({
      code: 0,
      err: "",
      trace:
        'remote\ngate\n{"table:reviewed":"migration completed"}\nremote\npush deploy -y\n',
    });
  });
});

test("the protected Swarm deploy workflow is manual-only and scopes the secret to deploy", async () => {
  const workflowDir = join(root, ".github/workflows");
  const workflow = Bun.YAML.parse(
    await Bun.file(join(workflowDir, workflowFile)).text(),
  ) as any;
  expect(workflow.on).toEqual({ workflow_dispatch: null });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toEqual({
    group: "swarm-production-backend",
    "cancel-in-progress": false,
  });
  expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
  const job = workflow.jobs.deploy;
  expect(job.if).toBe(
    "github.repository == 'littlebirdai/swarm' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  );
  expect(job.environment).toBe("swarm-production");
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(job.steps[0].uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
  expect(job.steps[0].with).toEqual({
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  expect(job.steps[1]).toEqual({ uses: "./.github/actions/setup-bun" });
  expect(job.steps).toHaveLength(3);
  expect(job.steps[2].env).toEqual({
    CONVEX_DEPLOY_KEY: "${{ secrets.SWARM_CONVEX_DEPLOY_KEY }}",
  });
  expect(job.steps[2].run).toBe(script);
  for (const other of new Bun.Glob("*.yml").scanSync(workflowDir)) {
    if (other !== workflowFile)
      expect(
        await Bun.file(join(workflowDir, other)).text(),
        other,
      ).not.toMatch(/deploy-swarm-backend\.yml|scripts\/deploy-backend\.sh/);
  }
});
