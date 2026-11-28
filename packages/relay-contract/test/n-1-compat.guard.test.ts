import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as current from "../src";
import * as previous from "./n-1/schema";

type WireObject = Record<string, unknown>;
type ParseResult = { ok: boolean; value?: unknown; error?: unknown };
type Parser = (value: unknown) => ParseResult;

const N1_DIR = join(import.meta.dir, "n-1");
const FIXTURES_DIR = join(N1_DIR, "fixtures");
const CURRENT_FIXTURES_DIR = join(import.meta.dir, "fixtures");

const IMPORT_RE =
  /(?:^|[;\r\n])\s*(?:import|export)\s+(?:(?:type\s+)?[^;]*?\s+from\s+)?(["'])([^"']+)\1/gm;
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const N1_HELLO_STATUSES = new Set([
  "ok",
  "incompatible_version",
  "unauthorized",
  "unavailable",
]);
const N1_GRANT_RESULT_STATUSES = new Set(["applied", "released", "refused"]);
const N1_SUBSCRIPTION_STATUSES = new Set([
  "subscribed",
  "denied",
  "unsubscribed",
]);
const N1_PRESENCE_STATES = new Set(["active", "left"]);
const N1_SIGNAL_TYPES = new Set([
  "draft_cursor",
  "reading_cursor",
  "baton_heartbeat",
  "session_liveness",
  "machine_liveness",
]);

const THREE_STEP_GUIDANCE =
  "Make breaking contract changes in three steps: " +
  "(1) expand — add the new field or frame type while keeping the N-1 field or frame type accepted and emitted; " +
  "(2) migrate — deploy the relay and kernel and wait until clients and machines upgrade past N-1; " +
  "(3) contract — refresh the N-1 baseline when cutting the next release, then remove the old N-1 field or frame type.";

function failBreaking(detail: string): never {
  throw new Error(
    `Breaking change to N-1 relay contract: ${detail}\n${THREE_STEP_GUIDANCE}`,
  );
}

function getParser(contract: Record<string, unknown>, name: string): Parser {
  const fn = contract[name];
  if (typeof fn !== "function") {
    failBreaking(`missing parser ${name}.`);
  }
  return fn as Parser;
}

function assertMatchesN1(parse: Parser, wire: unknown, label: string): void {
  const encoded = typeof wire === "string" ? wire : JSON.stringify(wire);
  const result = parse(encoded);
  if (!result.ok) {
    failBreaking(
      `${label} failed to decode (${JSON.stringify(result.error)}).`,
    );
  }
  if (!Bun.deepEquals(result.value, wire, true)) {
    failBreaking(
      `${label} dropped or altered N-1 fields: expected ${JSON.stringify(wire)}, got ${JSON.stringify(result.value)}.`,
    );
  }
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findDisallowedImportsForSource(
  schemaDir: string,
  allowedRoots: readonly string[],
  relFile: string,
  source: string,
): string[] {
  const found = new Set<string>();
  for (const item of tsTranspiler.scanImports(source)) {
    found.add(item.path);
  }
  for (const match of source.matchAll(IMPORT_RE)) {
    found.add(match[2]!);
  }
  const fileDir = dirname(resolve(schemaDir, relFile));
  const bad: string[] = [];
  for (const specifier of found) {
    if (!specifier.startsWith(".")) {
      bad.push(`${relFile}: non-relative import "${specifier}"`);
      continue;
    }
    const target = resolve(fileDir, specifier);
    if (!allowedRoots.some((root) => isInsideRoot(root, target))) {
      bad.push(`${relFile}: escaping import "${specifier}"`);
    }
  }
  return bad;
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function dirHashes(dir: string): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const sub of ["schema", "fixtures"]) {
    const files = await walkFiles(join(dir, sub));
    for (const file of files) {
      const rel = `${sub}/${file}`;
      const bytes = await readFile(join(dir, rel));
      entries.push([
        rel,
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      ]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

function isN1CompatibleServerFrame(frame: WireObject): boolean {
  const type = frame.type;
  if (type === "hello") {
    if (
      typeof frame.status !== "string" ||
      !N1_HELLO_STATUSES.has(frame.status)
    ) {
      return false;
    }
    return (
      frame.status !== "ok" || frame.version === previous.RELAY_PROTOCOL_VERSION
    );
  }
  if (frame.v !== previous.RELAY_PROTOCOL_VERSION) {
    return false;
  }
  if (type === "grant_result") {
    return (
      typeof frame.status === "string" &&
      N1_GRANT_RESULT_STATUSES.has(frame.status)
    );
  }
  if (type === "subscription") {
    return (
      typeof frame.status === "string" &&
      N1_SUBSCRIPTION_STATUSES.has(frame.status)
    );
  }
  if (type === "presence") {
    return (
      typeof frame.state === "string" && N1_PRESENCE_STATES.has(frame.state)
    );
  }
  return typeof type === "string" && N1_SIGNAL_TYPES.has(type);
}

export async function assertRelayBackwardCompatible(
  contract: Record<string, unknown>,
  fixturesDir = FIXTURES_DIR,
): Promise<void> {
  if (contract.RELAY_PROTOCOL_VERSION === undefined) {
    failBreaking("missing RELAY_PROTOCOL_VERSION.");
  }
  if (contract.RELAY_GRANT_VERSION === undefined) {
    failBreaking("missing RELAY_GRANT_VERSION.");
  }
  if (typeof contract.negotiateRelayVersion !== "function") {
    failBreaking("missing negotiateRelayVersion.");
  }
  const supportedVersions = contract.RELAY_SUPPORTED_VERSIONS;
  if (
    !Array.isArray(supportedVersions) ||
    !supportedVersions.includes(previous.RELAY_PROTOCOL_VERSION)
  ) {
    failBreaking(
      `RELAY_SUPPORTED_VERSIONS does not include N-1 version ${previous.RELAY_PROTOCOL_VERSION}.`,
    );
  }
  const negotiated = (
    contract.negotiateRelayVersion as (
      offered: readonly number[],
    ) => number | null
  )([previous.RELAY_PROTOCOL_VERSION]);
  if (negotiated !== previous.RELAY_PROTOCOL_VERSION) {
    failBreaking(
      `negotiateRelayVersion([${previous.RELAY_PROTOCOL_VERSION}]) returned ${String(negotiated)}.`,
    );
  }

  const parseClient = getParser(contract, "parseRelayClientFrame");
  const parseServer = getParser(contract, "parseRelayServerFrame");
  const parseClaims = getParser(contract, "parseRelayGrantClaims");

  const clientFrames = await loadJson<WireObject[]>(
    join(fixturesDir, "client-frames.json"),
  );
  const serverFrames = await loadJson<WireObject[]>(
    join(fixturesDir, "server-frames.json"),
  );
  const grantClaims = await loadJson<WireObject[]>(
    join(fixturesDir, "grant-claims.json"),
  );

  for (const [index, frame] of clientFrames.entries()) {
    assertMatchesN1(
      parseClient,
      frame,
      `client frame[${index}] (${String(frame.type)})`,
    );
  }
  for (const [index, frame] of serverFrames.entries()) {
    assertMatchesN1(
      parseServer,
      frame,
      `server frame[${index}] (${String(frame.type)})`,
    );
  }
  for (const [index, claims] of grantClaims.entries()) {
    assertMatchesN1(parseClaims, claims, `grant claims[${index}]`);
  }
}

describe("relay contract N-1 compatibility guard", () => {
  test("frozen N-1 baseline manifest matches every committed schema and fixture file", async () => {
    const manifest = await loadJson<{
      revision: string | null;
      hashes: Record<string, string>;
    }>(join(N1_DIR, "manifest.json"));
    expect(await dirHashes(N1_DIR)).toEqual(manifest.hashes);
  });

  test("current relay-contract preserves all N-1 versions, grant claims, and frames", async () => {
    await assertRelayBackwardCompatible(current);
  });

  test("frozen N-1 schema imports stay inside frozen N-1 schema directories", async () => {
    const schemaDir = resolve(N1_DIR, "schema");
    const allowedRoots = [schemaDir];
    const bad: string[] = [];
    for (const relFile of await walkFiles(schemaDir)) {
      if (!relFile.endsWith(".ts")) continue;
      const source = await readFile(join(schemaDir, relFile), "utf8");
      bad.push(
        ...findDisallowedImportsForSource(
          schemaDir,
          allowedRoots,
          relFile,
          source,
        ),
      );
    }
    expect(bad).toEqual([]);
    expect(
      findDisallowedImportsForSource(
        schemaDir,
        allowedRoots,
        "frames.ts",
        'import { X } from "@codecast/edge-contract";\nexport const x = X;\n',
      ),
    ).toEqual(['frames.ts: non-relative import "@codecast/edge-contract"']);
    expect(
      findDisallowedImportsForSource(
        schemaDir,
        allowedRoots,
        "frames.ts",
        'import { X } from "../../src/frames";\nexport const x = X;\n',
      ),
    ).toEqual(['frames.ts: escaping import "../../src/frames"']);
  });

  test("frozen N-1 server frame decoder tolerates additive fields on compatible current fixtures", async () => {
    const serverFrames = await loadJson<WireObject[]>(
      join(CURRENT_FIXTURES_DIR, "server-frames.json"),
    );
    const compatible = serverFrames.filter(isN1CompatibleServerFrame);
    expect(compatible.length).toBeGreaterThan(0);
    for (const frame of compatible) {
      const base = previous.parseRelayServerFrame(JSON.stringify(frame));
      expect(base.ok, `decode ${String(frame.type)}`).toBe(true);
      expect(
        previous.parseRelayServerFrame(
          JSON.stringify({ ...frame, future_additive_field: true }),
        ),
      ).toEqual(base);
    }
    expect(isN1CompatibleServerFrame({ type: "future_frame", v: 1 })).toBe(
      false,
    );
    expect(
      isN1CompatibleServerFrame({ type: "presence", v: 2, state: "active" }),
    ).toBe(false);
    const helloOk = compatible.find(
      (frame) => frame.type === "hello" && frame.status === "ok",
    );
    expect(helloOk).toBeDefined();
    expect(
      previous.parseRelayServerFrame(
        JSON.stringify({ ...helloOk, server_time_ms: 123 }),
      ),
    ).toEqual(previous.parseRelayServerFrame(JSON.stringify(helloOk)));
  });

  test("guard fails with expand/migrate/contract guidance when a frame, version, or field is removed or renamed", async () => {
    const missingParser = { ...current, parseRelayClientFrame: undefined };
    await expect(assertRelayBackwardCompatible(missingParser)).rejects.toThrow(
      /expand[\s\S]*migrate[\s\S]*contract/i,
    );

    const droppedVersion = { ...current, RELAY_SUPPORTED_VERSIONS: [2] };
    await expect(assertRelayBackwardCompatible(droppedVersion)).rejects.toThrow(
      /expand[\s\S]*migrate[\s\S]*contract/i,
    );

    const droppedFrameField = {
      ...current,
      parseRelayServerFrame: (wire: unknown) => {
        const parsed = current.parseRelayServerFrame(wire);
        if (!parsed.ok) return parsed;
        if (parsed.value.type === "presence") {
          const { in_draft: _dropped, ...rest } = parsed.value;
          return { ok: true, value: rest };
        }
        return parsed;
      },
    };
    await expect(
      assertRelayBackwardCompatible(droppedFrameField),
    ).rejects.toThrow(/expand[\s\S]*migrate[\s\S]*contract/i);
  });
});
