import { describe, it, expect, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMachineKey, MACHINE_KEY_LEN } from "./machine-key.js";
import {
  encryptTokenWithSecret,
  decryptTokenWithSecrets,
  TokenDecryptError,
} from "./tokenEncryption.js";

const HW_A = () => "AAAAAAAA-1111-2222-3333-444444444444";
const HW_B = () => "BBBBBBBB-5555-6666-7777-888888888888";
const HW_NONE = () => "";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codecast-mk-"));
}

/** Simulate Migration Assistant: copy the whole ~/.codecast identity onto new hardware. */
function cloneDir(src: string): string {
  const dst = tmpDir();
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  return dst;
}

describe("machineKey hardware binding", () => {
  it("uses the key published by a concurrent first run", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    const read = fs.readFileSync;
    let winner: ReturnType<typeof resolveMachineKey> | undefined;
    const intercept = spyOn(fs, "readFileSync").mockImplementation(
      new Proxy(read, {
        apply(target, receiver, args: Parameters<typeof read>) {
          if (args[0] !== keyFile) return Reflect.apply(target, receiver, args);
          try {
            return Reflect.apply(target, receiver, args);
          } catch (err) {
            intercept.mockRestore();
            winner = resolveMachineKey(dir, HW_A);
            throw err;
          }
        },
      }),
    );
    try {
      const result = resolveMachineKey(dir, HW_A);
      expect(winner?.secret).toEqual(result.secret);
      expect(result.secret).toEqual(read(keyFile));
      expect(fs.readdirSync(dir).sort()).toEqual([
        ".machine_key",
        ".machine_key.hostid",
      ]);
    } finally {
      intercept.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["hard-link publish", "exclusive-create fallback"])(
    "decrypts tokens from both processes after concurrent first runs with %s",
    async (publication) => {
      const dir = tmpDir();
      const keyFile = path.join(dir, ".machine_key");
      const script = `
      import { spyOn } from "bun:test";
      import * as fs from "node:fs";
      import { resolveMachineKey } from "./src/machine-key.ts";
      import { encryptTokenWithSecret } from "./src/tokenEncryption.ts";

      if (process.env.TEST_NO_HARD_LINKS === "1") {
        spyOn(fs, "linkSync").mockImplementation(() => {
          throw Object.assign(new Error("Hard links unavailable"), { code: "ENOTSUP" });
        });
      }
      const read = fs.readFileSync;
      const intercept = spyOn(fs, "readFileSync").mockImplementation((...args) => {
        if (args[0] !== process.env.TEST_KEY_FILE) return read(...args);
        try {
          return read(...args);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          intercept.mockRestore();
          fs.writeSync(1, "R");
          if (fs.readSync(0, Buffer.alloc(1)) !== 1) throw new Error("Missing start signal");
          throw err;
        }
      });
      const { secret } = resolveMachineKey(process.env.TEST_KEY_DIR, () => ${JSON.stringify(HW_A())});
      console.log(encryptTokenWithSecret("first run token", secret));
    `;
      const children = Array.from({ length: 2 }, () =>
        Bun.spawn([process.execPath, "-e", script], {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            ...process.env,
            TEST_KEY_DIR: dir,
            TEST_KEY_FILE: keyFile,
            TEST_NO_HARD_LINKS:
              publication === "exclusive-create fallback" ? "1" : "0",
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          signal: AbortSignal.timeout(5_000),
        }),
      );
      const readers = children.map((child) => child.stdout.getReader());
      try {
        await Promise.all(
          readers.map(async (reader) => {
            const { value } = await reader.read();
            expect(new TextDecoder().decode(value)).toBe("R");
          }),
        );
        for (const child of children) {
          child.stdin.write("x");
          child.stdin.end();
        }
        const ciphertexts = await Promise.all(
          readers.map(async (reader) => {
            const chunks: Uint8Array[] = [];
            for (
              let next = await reader.read();
              !next.done;
              next = await reader.read()
            ) {
              chunks.push(next.value);
            }
            return Buffer.concat(chunks).toString().trim();
          }),
        );
        expect(
          await Promise.all(children.map((child) => child.exited)),
        ).toEqual([0, 0]);
        const { secret } = resolveMachineKey(dir, HW_A);
        for (const encrypted of ciphertexts) {
          expect(decryptTokenWithSecrets(encrypted, [secret])).toBe(
            "first run token",
          );
        }
      } finally {
        for (const child of children) child.kill();
        await Promise.all(children.map((child) => child.exited));
        for (const reader of readers) reader.releaseLock();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it("replaces a short key atomically and reads a concurrent repair", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    const competingFile = path.join(dir, "other-writer");
    const winner = Buffer.alloc(MACHINE_KEY_LEN, 42);
    const rename = fs.renameSync;
    const intercept = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to !== keyFile) return rename(from, to);
      expect(fs.readFileSync(keyFile, "utf8")).toBe("short");
      rename(from, to);
      expect(fs.readFileSync(keyFile).length).toBe(MACHINE_KEY_LEN);
      rename(competingFile, keyFile);
    });
    try {
      fs.writeFileSync(keyFile, "short");
      fs.writeFileSync(competingFile, winner, { mode: 0o600 });
      expect(resolveMachineKey(dir, HW_NONE).secret).toEqual(winner);
      expect(fs.readFileSync(keyFile)).toEqual(winner);
      expect(fs.readdirSync(dir)).toEqual([".machine_key"]);
    } finally {
      intercept.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"])(
    "creates a private key if hard links return %s",
    (code) => {
      const dir = tmpDir();
      const keyFile = path.join(dir, ".machine_key");
      const link = spyOn(fs, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("Hard links unavailable"), { code });
      });
      try {
        const result = resolveMachineKey(dir, HW_NONE);
        expect(result.secret.length).toBe(MACHINE_KEY_LEN);
        expect(result.secret).toEqual(fs.readFileSync(keyFile));
        if (process.platform !== "win32") {
          expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
        }
        expect(fs.readdirSync(dir)).toEqual([".machine_key"]);
      } finally {
        link.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("waits for an exclusive-create winner to finish a short key", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    const winner = Buffer.alloc(MACHINE_KEY_LEN, 42);
    const read = fs.readFileSync;
    let shortReads = 0;
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("Hard links unavailable"), {
        code: "ENOTSUP",
      });
    });
    const intercept = spyOn(fs, "readFileSync").mockImplementation(
      new Proxy(read, {
        apply(target, receiver, args: Parameters<typeof read>) {
          const bytes = Reflect.apply(target, receiver, args);
          if (args[0] === keyFile && ++shortReads === 2) {
            fs.writeFileSync(keyFile, winner);
          }
          return bytes;
        },
      }),
    );
    try {
      fs.writeFileSync(keyFile, "", { flag: "wx", mode: 0o600 });
      expect(resolveMachineKey(dir, HW_NONE).secret).toEqual(winner);
      expect(read(keyFile)).toEqual(winner);
    } finally {
      intercept.mockRestore();
      link.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates unrelated link errors and removes the temp file", () => {
    const dir = tmpDir();
    const failure = Object.assign(new Error("Link I/O failed"), {
      code: "EIO",
    });
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => resolveMachineKey(dir, HW_A)).toThrow(failure);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      link.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the key unpublished if its sync fails", () => {
    const dir = tmpDir();
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("key sync failed");
    });
    try {
      expect(() => resolveMachineKey(dir, HW_A)).toThrow("key sync failed");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      sync.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the published key when the first hostid write fails", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    const rename = fs.renameSync;
    const intercept = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === path.join(dir, ".machine_key.hostid"))
        throw new Error("hostid write failed");
      rename(from, to);
    });
    try {
      expect(() => resolveMachineKey(dir, HW_A)).toThrow("hostid write failed");
      const published = fs.readFileSync(keyFile);
      intercept.mockRestore();
      expect(resolveMachineKey(dir, HW_A).secret).toEqual(published);
      expect(fs.readdirSync(dir).sort()).toEqual([
        ".machine_key",
        ".machine_key.hostid",
      ]);
    } finally {
      intercept.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a key and hostid sidecar on first run, stable afterwards", () => {
    const dir = tmpDir();
    const first = resolveMachineKey(dir, HW_A);
    expect(first.secret.length).toBe(MACHINE_KEY_LEN);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dir, ".machine_key")).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(first.rotated).toBe(false);
    expect(fs.existsSync(path.join(dir, ".machine_key.hostid"))).toBe(true);

    const second = resolveMachineKey(dir, HW_A);
    expect(second.secret.equals(first.secret)).toBe(true);
    expect(second.rotated).toBe(false);
  });

  it("adopts a pre-binding key without changing it (upgrade path)", () => {
    const dir = tmpDir();
    const legacyKey = crypto.randomBytes(MACHINE_KEY_LEN);
    fs.writeFileSync(path.join(dir, ".machine_key"), legacyKey, {
      mode: 0o600,
    });

    const result = resolveMachineKey(dir, HW_A);
    expect(result.secret.equals(legacyKey)).toBe(true);
    expect(result.rotated).toBe(false);
    expect(fs.existsSync(path.join(dir, ".machine_key.hostid"))).toBe(true);
  });

  it("rotates when the key lands on different hardware (Migration Assistant clone)", () => {
    const macA = tmpDir();
    const original = resolveMachineKey(macA, HW_A);

    const macB = cloneDir(macA);
    const cloned = resolveMachineKey(macB, HW_B);

    expect(cloned.rotated).toBe(true);
    expect(cloned.secret.equals(original.secret)).toBe(false);
    expect(cloned.previousSecret!.equals(original.secret)).toBe(true);

    // Device ids (sha256 of the secret) diverge — the collision is gone.
    const idOf = (s: Buffer) =>
      crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
    expect(idOf(cloned.secret)).not.toBe(idOf(original.secret));

    // Mac A is untouched and stable.
    const originalAgain = resolveMachineKey(macA, HW_A);
    expect(originalAgain.secret.equals(original.secret)).toBe(true);
    expect(originalAgain.rotated).toBe(false);

    // Mac B is stable after the one-time rotation, prev still available.
    const clonedAgain = resolveMachineKey(macB, HW_B);
    expect(clonedAgain.secret.equals(cloned.secret)).toBe(true);
    expect(clonedAgain.rotated).toBe(false);
    expect(clonedAgain.previousSecret!.equals(original.secret)).toBe(true);
  });

  it("rotation is deterministic — concurrent detectors converge on the same key", () => {
    const macA = tmpDir();
    resolveMachineKey(macA, HW_A);

    const clone1 = resolveMachineKey(cloneDir(macA), HW_B);
    const clone2 = resolveMachineKey(cloneDir(macA), HW_B);
    expect(clone1.secret.equals(clone2.secret)).toBe(true);
  });

  it("returns the rotated key when another reader completes the move during a key read", () => {
    const dir = tmpDir();
    const original = resolveMachineKey(dir, HW_A);
    const keyFile = path.join(dir, ".machine_key");
    const read = fs.readFileSync;
    let concurrent: ReturnType<typeof resolveMachineKey> | undefined;
    const intercept = spyOn(fs, "readFileSync").mockImplementation(
      new Proxy(read, {
        apply(target, receiver, args: Parameters<typeof read>) {
          const bytes = Reflect.apply(target, receiver, args);
          if (args[0] === keyFile) {
            intercept.mockRestore();
            concurrent = resolveMachineKey(dir, HW_B);
          }
          return bytes;
        },
      }),
    );
    try {
      const result = resolveMachineKey(dir, HW_B);
      expect(concurrent?.rotated).toBe(true);
      expect(concurrent?.secret).toEqual(result.secret);
      expect(result.previousSecret).toEqual(original.secret);
      expect(resolveMachineKey(dir, HW_B).secret).toEqual(result.secret);
    } finally {
      intercept.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from a rotation interrupted before the sidecar write", () => {
    const macA = tmpDir();
    const original = resolveMachineKey(macA, HW_A);

    const macB = cloneDir(macA);
    const rotated = resolveMachineKey(macB, HW_B);

    // Rewind the sidecar to Mac A's hostid, as if the rotation crashed after
    // writing key+prev but before the sidecar.
    fs.copyFileSync(
      path.join(macA, ".machine_key.hostid"),
      path.join(macB, ".machine_key.hostid"),
    );

    const recovered = resolveMachineKey(macB, HW_B);
    // Must finish the interrupted rotation, not rotate a second time.
    expect(recovered.secret.equals(rotated.secret)).toBe(true);
    // prev must NOT be clobbered — it still holds the original key.
    expect(recovered.previousSecret!.equals(original.secret)).toBe(true);
  });

  it("never rotates when no hardware id is available", () => {
    const dir = tmpDir();
    const first = resolveMachineKey(dir, HW_NONE);
    expect(fs.existsSync(path.join(dir, ".machine_key.hostid"))).toBe(false);

    // Even with a foreign sidecar present, no hardware id → no rotation.
    fs.writeFileSync(path.join(dir, ".machine_key.hostid"), "deadbeef\n");
    const second = resolveMachineKey(dir, HW_NONE);
    expect(second.secret.equals(first.secret)).toBe(true);
    expect(second.rotated).toBe(false);
  });

  it("auth token encrypted before rotation still decrypts via previousSecret", () => {
    const macA = tmpDir();
    const original = resolveMachineKey(macA, HW_A);
    const token = "cxt_migrated_token_value";
    const encrypted = encryptTokenWithSecret(
      token,
      original.secret.subarray(0, MACHINE_KEY_LEN),
    );

    const cloned = resolveMachineKey(cloneDir(macA), HW_B);
    const chain = [
      cloned.secret.subarray(0, MACHINE_KEY_LEN),
      cloned.previousSecret!.subarray(0, MACHINE_KEY_LEN),
    ];
    expect(decryptTokenWithSecrets(encrypted, chain)).toBe(token);

    // Without the previous key the rotated machine could not decrypt.
    expect(() => decryptTokenWithSecrets(encrypted, [chain[0]])).toThrow(
      TokenDecryptError,
    );
  });
});
