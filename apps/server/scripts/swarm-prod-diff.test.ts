import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swarm-inventory-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "scripts"));
mkdirSync(join(dir, "convex"));
copyFileSync(
  join(import.meta.dir, "prod-diff.ts"),
  join(dir, "scripts/prod-diff.ts"),
);
writeFileSync(
  join(dir, "convex/schema.ts"),
  `
if (process.env.CONVEX_DEPLOY_KEY) throw new Error("tree subprocess received the deploy key");
export default { export: () => JSON.stringify({ tables: [{ tableName: "sessions", indexes: [] }] }) };
`,
);
writeFileSync(
  join(dir, "fake-fetch.ts"),
  `
globalThis.fetch = async (url, opts) => {
  if (url !== "https://test-deployment.convex.cloud/api/query" ||
      opts.method !== "POST" ||
      opts.headers.Authorization !== "Convex " + process.env.CONVEX_DEPLOY_KEY) {
    throw new Error("unexpected production request");
  }
  const { path } = JSON.parse(opts.body);
  const prod = JSON.parse(process.env.FAKE_PROD_INVENTORY);
  const value = path === "_system/cli/modules:apiSpec" ? prod.spec :
    path === "_system/frontend/getSchemas" ? prod.schemas : undefined;
  return Response.json({ status: "success", value });
};
`,
);

const fn = { identifier: "sessions.js:list", functionType: "Query" };
const route = {
  method: "POST",
  path: "/cli/heartbeat",
  functionType: "HttpAction",
};
const index = { indexDescriptor: "by_owner" };

function gate(
  spec: unknown[],
  tables: unknown[],
  allowlist: unknown = {},
  schemas?: object,
) {
  const r = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./fake-fetch.ts",
      "scripts/prod-diff.ts",
      "--swarm-gate",
      "test-deployment",
    ],
    {
      cwd: dir,
      env: {
        CONVEX_DEPLOY_KEY: "prod:test-deployment|fake-test-value",
        FAKE_PROD_INVENTORY: JSON.stringify({
          spec,
          schemas: schemas ?? { active: JSON.stringify({ tables }) },
        }),
      },
      stdin: Buffer.from(JSON.stringify(allowlist)),
    },
  );
  return { code: r.exitCode, err: r.stderr.toString() };
}

const sessions = { tableName: "sessions" };
const indexedSessions = { ...sessions, indexes: [index] };

test.each([
  ["fn:sessions:list", [fn], [sessions]],
  ["http:POST /cli/heartbeat", [route], [sessions]],
  ["index:sessions.by_owner", [], [indexedSessions]],
  ["table:legacy", [], [sessions, { tableName: "legacy" }]],
] as const)("blocks the unapproved removal of %s", (name, spec, tables) => {
  const result = gate([...spec], [...tables]);
  expect(result.code).toBe(1);
  expect(result.err).toContain(`UNAPPROVED ${name}`);
});

test("allows only the exact names with committed review reasons", () => {
  const allowlist = {
    "fn:sessions:list": "Approved client migration",
    "http:POST /cli/*": "Approved only this prefix route",
  };
  const partial = gate([fn, route], [sessions], allowlist);
  expect(partial.code).toBe(1);
  expect(partial.err).toContain("UNAPPROVED http:POST /cli/heartbeat");
  expect(partial.err).not.toContain("UNAPPROVED fn:sessions:list");
  expect(gate([fn], [sessions], allowlist).code).toBe(0);
  expect(gate([fn], [sessions], { "fn:sessions:list": " " }).code).toBe(3);
});

test("fails closed when a production inventory response is incomplete", () => {
  expect(gate([], [], {}, {}).err).toContain("active schema or null");
  const unknown = gate(
    [{ functionType: "HttpAction", path: "/lost" }],
    [sessions],
  );
  expect(unknown.code).toBe(3);
  expect(unknown.err).toContain("unrecognized function or route");
});

test("allows a deploy with no removals", () => {
  const result = gate([], [sessions]);
  expect(result.code).toBe(0);
  expect(result.err).toContain("0 drops, 0 adds");
});
