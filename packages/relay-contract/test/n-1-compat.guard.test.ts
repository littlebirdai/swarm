import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as current from "../src";
import * as previous from "./n-1/schema";

type WireObject = Record<string, unknown>;
type ParseResult = { ok: boolean; value?: unknown; error?: unknown };
type Parser = (value: unknown) => ParseResult;

const N1_DIR = join(import.meta.dir, "n-1");
const FIXTURES_DIR = join(N1_DIR, "fixtures");

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

async function dirHashes(dir: string): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const sub of ["schema", "fixtures"]) {
    const files = (await readdir(join(dir, sub))).sort();
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

  test("frozen N-1 server frame decoder tolerates additive fields", async () => {
    const serverFrames = await loadJson<WireObject[]>(
      join(FIXTURES_DIR, "server-frames.json"),
    );
    for (const frame of serverFrames) {
      const parsed = previous.parseRelayServerFrame(
        JSON.stringify({ ...frame, future_additive_field: true }),
      );
      expect(parsed).toEqual({
        ok: true,
        value: frame as previous.RelayServerFrame,
      });
    }
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
