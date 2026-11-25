import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as current from "../../packages/edge-contract/src";
import { diffNames, runTreeChild } from "../../apps/server/scripts/prod-diff";
import {
  fixtureHashes,
  git as gitAt,
  readClientInventory,
  releaseBaseline,
  releasePath,
  root,
} from "./freeze-edge-contract";

type Manifest = { revision: string; hashes: Record<string, string> };
type WireObject = Record<string, unknown>;
type WirePair = { request: WireObject; response: WireObject };
const frozenRoot = join(root, releasePath);
const currentDir = join(dirname(frozenRoot), "fixtures");
const git = (...args: string[]) => gitAt(root, ...args);

test("existing release directories are append-only", () => {
  releaseBaseline(root, process.env.EDGE_RELEASE_BASE);
});

const edgeSource = "packages/edge-contract/src";
async function loadPrevious(
  revision: string,
  tmp: string,
): Promise<typeof current> {
  for (const path of git("ls-tree", "-r", "--name-only", revision, edgeSource)
    .trim()
    .split("\n")) {
    const dest = join(tmp, path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, git("show", `${revision}:${path}`));
  }
  return import(join(tmp, edgeSource, "index.ts"));
}

const verbs = [
  "hello",
  "heartbeat",
  "policy.get",
  "events.append",
  "blobs.put",
  "permits.next",
  "delivery.start",
  "delivery.settle",
  "commands.next",
  "commands.result",
  "claim",
  "renew",
  "release",
] as const;
const stems = verbs.map(
  (verb) =>
    [
      verb,
      verb.replace(/(^|\.)([a-z])/g, (_, __, letter: string) =>
        letter.toUpperCase(),
      ),
    ] as const,
);

const versions = releaseBaseline(root, process.env.EDGE_RELEASE_BASE);
for (const version of versions) {
  const dir = join(frozenRoot, version);
  test(`frozen ${version} fixtures match their manifest`, async () => {
    const manifest: Manifest = await Bun.file(
      join(dir, "manifest.json"),
    ).json();
    expect(
      await fixtureHashes(
        dir,
        (await readdir(dir)).filter((file) => file !== "manifest.json"),
      ),
    ).toEqual(manifest.hashes);
  });
}

const latest = versions.at(-1);
if (latest)
  describe(`edge compatibility with ${latest}`, () => {
    const previousDir = join(frozenRoot, latest);
    const tmp = mkdtempSync(join(tmpdir(), "edge-release-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    test("the new server parser reads frozen daemon requests and retains response variants", async () => {
      const variants: Record<string, WireObject[]> = await Bun.file(
        join(previousDir, "response-variants.json"),
      ).json();
      const errors: WireObject[] = await Bun.file(
        join(previousDir, "errors.json"),
      ).json();
      for (const [verb, stem] of stems) {
        const request = Reflect.get(current, `parse${stem}Request`);
        const response = Reflect.get(current, `parse${stem}Response`);
        const wire: WirePair = await Bun.file(
          join(previousDir, `${verb}.json`),
        ).json();
        expect(request(wire.request), verb).toEqual({
          ok: true,
          value: wire.request,
        });
        for (const value of [
          wire.response,
          ...(variants[verb] ?? []),
          ...errors,
        ]) {
          expect(response(value), verb).toEqual({ ok: true, value });
        }
      }
      for (const file of ["prompt.opened", "tool-result-inline"]) {
        const value = await Bun.file(join(previousDir, `${file}.json`)).json();
        expect(current.parseCanonicalEvent(value), file).toEqual({
          ok: true,
          value,
        });
      }
      const delta = await Bun.file(
        join(previousDir, "message.delta.json"),
      ).json();
      expect(current.parseMessageDelta(delta)).toEqual({
        ok: true,
        value: delta,
      });

      const resolutions: Record<string, WirePair[]> = await Bun.file(
        join(previousDir, "delivery-resolution.json"),
      ).json();
      for (const { request, response } of Object.values(resolutions).flat()) {
        expect(current.parseDeliverySettleRequest(request)).toEqual({
          ok: true,
          value: request,
        });
        expect(current.parseDeliverySettleResponse(response)).toEqual({
          ok: true,
          value: response,
        });
      }

      const guarded = await Bun.file(
        join(previousDir, "guarded-actions.json"),
      ).json();
      const permit: WirePair = await Bun.file(
        join(previousDir, "permits.next.json"),
      ).json();
      const next: WirePair = await Bun.file(
        join(previousDir, "commands.next.json"),
      ).json();
      const settle: WirePair = await Bun.file(
        join(previousDir, "delivery.settle.json"),
      ).json();
      const result: WirePair = await Bun.file(
        join(previousDir, "commands.result.json"),
      ).json();
      const steer = { ...permit.response, ...guarded.steer };
      expect(current.parsePermitsNextResponse(steer)).toEqual({
        ok: true,
        value: steer,
      });
      const staleSteer = { ...settle.request, ...guarded.stale_steer };
      expect(current.parseDeliverySettleRequest(staleSteer)).toEqual({
        ok: true,
        value: staleSteer,
      });
      for (const fields of guarded.commands) {
        const command = { ...next.response, ...fields };
        expect(current.parseCommandsNextResponse(command)).toEqual({
          ok: true,
          value: command,
        });
      }
      const { output: _output, ...request } = result.request;
      for (const fields of guarded.stale_commands) {
        const staleCommand = { ...request, ...fields };
        expect(current.parseCommandsResultRequest(staleCommand)).toEqual({
          ok: true,
          value: staleCommand,
        });
      }
    });

    test("the frozen daemon parser accepts current responses and ignores additive fields", async () => {
      const manifest: Manifest = await Bun.file(
        join(previousDir, "manifest.json"),
      ).json();
      const previous = await loadPrevious(manifest.revision, tmp);
      const variants: Record<string, WireObject[]> = await Bun.file(
        join(currentDir, "response-variants.json"),
      ).json();
      const errors: WireObject[] = await Bun.file(
        join(currentDir, "errors.json"),
      ).json();
      for (const [verb, stem] of stems) {
        const response = Reflect.get(previous, `parse${stem}Response`);
        const wire: WirePair = await Bun.file(
          join(currentDir, `${verb}.json`),
        ).json();
        for (const value of [
          wire.response,
          ...(variants[verb] ?? []),
          ...errors,
        ]) {
          const parsed = response(value);
          expect(parsed.ok, verb).toBe(true);
          expect(response({ ...value, future_field: true }), verb).toEqual(
            parsed,
          );
        }
      }
      const { response } = await Bun.file(
        join(currentDir, "policy.get.json"),
      ).json();
      const extended = {
        ...response,
        policy: {
          ...response.policy,
          future_policy_setting: true,
          limits: { ...response.policy.limits, future_limit: 17 },
        },
      };
      expect(previous.parsePolicyGetResponse(extended)).toEqual(
        previous.parsePolicyGetResponse(response),
      );
      const futureError = {
        v: 1,
        status: "error",
        code: "future_code",
        retryable: true,
        retry_after_ms: 1200,
      };
      expect(previous.parseEdgeErrorResponse(futureError)).toEqual({
        ok: true,
        value: futureError,
      });
    });

    test("the backend retains public functions and routes referenced by the frozen clients", async () => {
      const expected = readClientInventory(
        await Bun.file(join(previousDir, "client-inventory.txt")).text(),
      );
      const { drops } = diffNames(await runTreeChild("public"), expected);
      expect(
        drops,
        `Missing public entry points for ${latest}: ${drops.join(", ")}`,
      ).toEqual([]);
    }, 30_000);
  });
