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

  it("publishes beside the final target of a dangling symlink chain", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    const targetDir = path.join(dir, "identity");
    const target = path.join(targetDir, "key");
    const link = fs.linkSync;
    const intercept = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      expect(path.dirname(String(from))).toBe(targetDir);
      expect(path.basename(String(from))).toMatch(
        /^\.key\.\d+\.[0-9a-f-]{36}\.tmp$/,
      );
      expect(to).toBe(target);
      link(from, to);
    });
    try {
      fs.symlinkSync("jump", keyFile, "file");
      fs.symlinkSync("identity/key", path.join(dir, "jump"), "file");
      expect(resolveMachineKey(dir, HW_NONE).secret).toEqual(
        fs.readFileSync(target),
      );
      expect(fs.readlinkSync(keyFile)).toBe("jump");
      expect(fs.readlinkSync(path.join(dir, "jump"))).toBe("identity/key");
    } finally {
      intercept.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps stale temps for the key and leaves recent or unrelated files", () => {
    const dir = tmpDir();
    const stale = "..machine_key.123.11111111-1111-1111-1111-111111111111.tmp";
    const fresh = "..machine_key.123.22222222-2222-2222-2222-222222222222.tmp";
    const unrelated =
      "..unrelated.123.33333333-3333-3333-3333-333333333333.tmp";
    try {
      for (const name of [stale, fresh, unrelated]) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, "temp");
        if (name !== fresh) fs.utimesSync(file, 1, 1);
      }
      resolveMachineKey(dir, HW_NONE);
      expect(fs.readdirSync(dir).sort()).toEqual(
        [fresh, unrelated, ".machine_key"].sort(),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs the parent directory after publishing the key", () => {
    const dir = tmpDir();
    const sync = fs.fsyncSync;
    let syncedDirectory = false;
    const intercept = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        expect(fs.readFileSync(path.join(dir, ".machine_key")).length).toBe(
          MACHINE_KEY_LEN,
        );
        syncedDirectory = true;
      }
      sync(fd);
    });
    try {
      resolveMachineKey(dir, HW_NONE);
      if (process.platform !== "win32") expect(syncedDirectory).toBe(true);
    } finally {
      intercept.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries an ENOENT while rereading the publication winner", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    const winner = Buffer.alloc(MACHINE_KEY_LEN, 63);
    const read = fs.readFileSync;
    let reads = 0;
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("Path just existed"), { code: "EEXIST" });
    });
    const intercept = spyOn(fs, "readFileSync").mockImplementation(
      new Proxy(read, {
        apply(target, receiver, args: Parameters<typeof read>) {
          try {
            return Reflect.apply(target, receiver, args);
          } catch (err) {
            if (args[0] === keyFile && ++reads === 2)
              fs.writeFileSync(keyFile, winner);
            throw err;
          }
        },
      }),
    );
    try {
      expect(resolveMachineKey(dir, HW_NONE).secret).toEqual(winner);
    } finally {
      intercept.mockRestore();
      link.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["write", "fsync", "fsync after replacement"])(
    "cleans up only the fallback writer's file when %s fails",
    (failure) => {
      const dir = tmpDir();
      const keyFile = path.join(dir, ".machine_key");
      const competing = path.join(dir, "competing-key");
      const winner = Buffer.alloc(MACHINE_KEY_LEN, 7);
      const error = new Error("fallback write failed");
      const link = spyOn(fs, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("Hard links unavailable"), {
          code: "ENOTSUP",
        });
      });
      const sync = fs.fsyncSync;
      const syncIntercept = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (failure !== "write" && fs.existsSync(keyFile)) {
          if (failure === "fsync after replacement")
            fs.renameSync(competing, keyFile);
          throw error;
        }
        sync(fd);
      });
      const write = fs.writeFileSync;
      const writeIntercept = spyOn(fs, "writeFileSync").mockImplementation(
        (file, data, options) => {
          if (
            failure === "write" &&
            typeof file === "number" &&
            fs.existsSync(keyFile)
          )
            throw error;
          write(file, data, options);
        },
      );
      try {
        if (failure === "fsync after replacement")
          fs.writeFileSync(competing, winner);
        expect(() => resolveMachineKey(dir, HW_NONE)).toThrow(error);
        if (failure === "fsync after replacement") {
          expect(fs.readFileSync(keyFile)).toEqual(winner);
          expect(fs.readdirSync(dir)).toEqual([".machine_key"]);
        } else expect(fs.readdirSync(dir)).toEqual([]);
      } finally {
        writeIntercept.mockRestore();
        syncIntercept.mockRestore();
        link.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("adopts the current host when a missing key has a foreign hostid", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, ".machine_key");
    try {
      resolveMachineKey(dir, HW_A);
      fs.unlinkSync(keyFile);
      const first = resolveMachineKey(dir, HW_B);
      expect(first.rotated).toBe(false);
      expect(first.previousSecret).toBeNull();
      expect(resolveMachineKey(dir, HW_B).secret).toEqual(first.secret);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["EACCES", "EISDIR"])(
    "preserves the key path when its read returns %s",
    (code) => {
      const dir = tmpDir();
      const keyFile = path.join(dir, ".machine_key");
      const read = fs.readFileSync;
      const error = Object.assign(new Error("Key read failed"), { code });
      const intercept = spyOn(fs, "readFileSync").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, args: Parameters<typeof read>) {
            if (args[0] === keyFile) throw error;
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      try {
        if (code === "EISDIR") fs.mkdirSync(keyFile);
        else fs.writeFileSync(keyFile, "existing");
        expect(() => resolveMachineKey(dir, HW_NONE)).toThrow(error);
        if (code === "EISDIR")
          expect(fs.statSync(keyFile).isDirectory()).toBe(true);
        else expect(read(keyFile, "utf8")).toBe("existing");
        expect(fs.readdirSync(dir)).toEqual([".machine_key"]);
      } finally {
        intercept.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
