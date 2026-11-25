import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedInventory, type Inventory } from "./swarm-inventory";

const dir = mkdtempSync(join(tmpdir(), "swarm-inventory-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "scripts"));
mkdirSync(join(dir, "convex"));
for (const file of ["prod-diff.ts", "swarm-inventory.ts"]) {
  copyFileSync(join(import.meta.dir, file), join(dir, "scripts", file));
}
const schema = {
  tables: [
    {
      tableName: "sessions",
      indexes: [
        { indexDescriptor: "by_created", fields: ["created", "owner"] },
      ],
      stagedDbIndexes: [{ indexDescriptor: "by_staged", fields: ["owner"] }],
      searchIndexes: [
        {
          indexDescriptor: "search",
          searchField: "body",
          filterFields: ["room", "owner"],
        },
      ],
      vectorIndexes: [
        {
          indexDescriptor: "vector",
          vectorField: "embedding",
          dimensions: 12,
          filterFields: ["room", "owner"],
        },
      ],
    },
  ],
};
writeFileSync(
  join(dir, "convex/sessions.ts"),
  `
export const hidden = { isQuery: true, isInternal: true };
export const update = { isMutation: true, isPublic: true };
`,
);
writeFileSync(
  join(dir, "convex/crons.ts"),
  `
export default { isCrons: true, crons: { "hourly sweep": {} } };
`,
);
writeFileSync(
  join(dir, "convex/schema.ts"),
  `
if (process.env.CONVEX_DEPLOY_KEY) throw new Error("tree subprocess received the deploy key");
export default { export: () => JSON.stringify(${JSON.stringify(schema)}) };
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
  const { path, args } = JSON.parse(opts.body);
  const prod = JSON.parse(process.env.FAKE_PROD_INVENTORY);
  let value = path === "_system/cli/modules:apiSpec" ? prod.spec :
    path === "_system/frontend/getSchemas" ? prod.schemas : undefined;
  if (path === "_system/cli/tableData" && args.table === "_cron_jobs" && args.order === "asc") {
    const cursor = args.paginationOpts.cursor;
    value = cursor === null ? prod.crons[0] : cursor === "second" ? prod.crons[1] : undefined;
  }
  if (value === undefined) throw new Error("unexpected system query or cursor");
  return Response.json({ status: "success", value });
};
`,
);

const publicVisibility = { kind: "public" };
const fn = {
  identifier: "sessions.js:list",
  functionType: "Query",
  visibility: publicVisibility,
};
const route = {
  method: "POST",
  path: "/cli/heartbeat",
  functionType: "HttpAction",
};
const index = { indexDescriptor: "by_owner", fields: ["owner"] };

function gate(
  spec: unknown[],
  tables: unknown[],
  allowlist: unknown = {},
  schemas?: object,
  crons: unknown[] = [{ page: [{ name: "hourly sweep" }], isDone: true }],
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
          crons,
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
  expect(result.err).toContain("0 drops");
});

test.each([
  ["fn:sessions:hidden", { ...fn, identifier: "sessions.js:hidden" }],
  [
    "fn:sessions:update",
    { ...fn, identifier: "sessions.js:update", functionType: "Action" },
  ],
] as const)(
  "blocks a function kind or visibility change to %s",
  (name, before) => {
    const result = gate([before], [sessions]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`CHANGED ${name}`);
    expect(result.err).toContain(`UNAPPROVED ${name}`);
  },
);

test("accepts widening function visibility without changing its kind", () => {
  const before = {
    identifier: "sessions.js:update",
    functionType: "Mutation",
    visibility: { kind: "internal" },
  };
  expect(gate([before], [sessions]).code).toBe(0);
});

test.each([
  [
    "index:sessions.by_staged",
    { indexes: [{ indexDescriptor: "by_staged", fields: ["owner"] }] },
  ],
  [
    "index:sessions.by_created",
    {
      indexes: [
        {
          indexDescriptor: "by_created",
          fields: ["owner", "created", "_creationTime"],
        },
      ],
    },
  ],
  [
    "index:sessions.search",
    {
      searchIndexes: [
        {
          indexDescriptor: "search",
          searchField: "title",
          filterFields: ["room", "owner"],
        },
      ],
    },
  ],
  [
    "index:sessions.vector",
    {
      vectorIndexes: [
        {
          indexDescriptor: "vector",
          vectorField: "embedding",
          dimensions: 24,
          filterFields: ["room", "owner"],
        },
      ],
    },
  ],
] as const)(
  "blocks an index definition or active-state change to %s",
  (name, before) => {
    const result = gate([], [{ ...sessions, ...before }]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`UNAPPROVED ${name}`);
  },
);

test("accepts equivalent indexes and a compatible staged promotion", () => {
  const result = gate(
    [],
    [
      {
        ...sessions,
        stagedDbIndexes: [
          {
            indexDescriptor: "by_created",
            fields: ["created", "owner", "_creationTime"],
          },
        ],
        searchIndexes: [
          {
            indexDescriptor: "search",
            searchField: "body",
            filterFields: ["owner", "room"],
          },
        ],
        vectorIndexes: [
          {
            indexDescriptor: "vector",
            vectorField: "embedding",
            dimensions: 12,
            filterFields: ["owner", "room"],
          },
        ],
      },
    ],
  );
  expect(result.code).toBe(0);
});

test("blocks a removed cron on a later inventory page and warns about unused exceptions", () => {
  const crons = [
    {
      page: [{ name: "hourly sweep" }],
      isDone: false,
      continueCursor: "second",
    },
    { page: [{ name: "retired job" }], isDone: true },
  ];
  const result = gate(
    [],
    [sessions],
    { "cron:unrelated job": "Old migration" },
    undefined,
    crons,
  );
  expect(result.code).toBe(1);
  expect(result.err).toContain("UNAPPROVED cron:retired job");
  expect(result.err).toContain("UNUSED ALLOWLIST cron:unrelated job");
  expect(
    gate(
      [],
      [sessions],
      { "cron:retired job": "Old migration" },
      undefined,
      crons,
    ).code,
  ).toBe(0);
});

test.each([
  ["a cron without a name", [{ page: [{ identifier: "x" }], isDone: true }]],
  ["a missing cron page", [null]],
  ["a cron page without an end flag", [{ page: [] }]],
  ["an empty cron cursor", [{ page: [], isDone: false, continueCursor: "" }]],
  [
    "a repeated cron cursor",
    [
      { page: [], isDone: false, continueCursor: "second" },
      { page: [], isDone: false, continueCursor: "second" },
    ],
  ],
])("fails closed on %s", (_case, crons) => {
  expect(gate([], [sessions], {}, undefined, crons).code).toBe(3);
});

test.each([
  ["database", { indexes: [{ indexDescriptor: "bad" }] }],
  [
    "vector",
    {
      vectorIndexes: [
        {
          indexDescriptor: "bad",
          vectorField: "embedding",
          dimensions: 0,
          filterFields: [],
        },
      ],
    },
  ],
])("fails closed on a malformed %s index", (_kind, indexes) => {
  const result = gate([], [{ ...sessions, ...indexes }]);
  expect(result.code).toBe(3);
  expect(result.err).toContain("invalid definition for index:sessions.bad");
});

test("fails closed when the tree has no valid cron inventory", () => {
  const path = join(dir, "convex/crons.ts");
  const valid = readFileSync(path);
  writeFileSync(path, "export default {};");
  try {
    expect(gate([], [sessions]).code).toBe(3);
  } finally {
    writeFileSync(path, valid);
  }
});

test("compares index kinds that share a name", () => {
  const database = JSON.stringify(["database", true, ["owner"]]);
  const search = JSON.stringify(["search", true, ["body", []]]);
  const name = "index:sessions.same";
  const prod: Inventory = [
    [name, database],
    [name, search],
  ];
  expect(changedInventory(prod, prod)).toEqual([]);
  expect(changedInventory([[name, search]], prod)).toEqual([name]);
  expect(changedInventory([[name, database]], prod)).toEqual([name]);
});
