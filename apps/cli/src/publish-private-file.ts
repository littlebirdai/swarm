import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isPidAlive } from "./workspace/chrome.js";

const LINK_UNAVAILABLE = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
  "EMLINK",
]);
const PUBLICATION_WAIT_MS = 250;
const PUBLICATION_POLL_MS = 5;
const PARTIAL_PUBLICATION_GRACE_MS = 2_000;
const LOCK_OWNER = /^(\d+)\.[0-9a-f-]{36}$/;
const STALE_TEMP_MS = 60_000;
const publicationWait = new Int32Array(new SharedArrayBuffer(4));

export function publishPrivateFile(
  file: string,
  data: Uint8Array | string,
  isIncomplete?: (target: string) => boolean,
): boolean {
  let target = file;
  for (let hops = 0; ; hops++) {
    if (hops === 40) throw new Error(`Too many symlink hops for ${file}`);
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) break;
      target = resolve(dirname(target), fs.readlinkSync(target));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      break;
    }
  }
  const directory = dirname(target);
  const tempPrefix = `.${basename(target)}.`;
  const temp = join(
    directory,
    `${tempPrefix}${process.pid}.${randomUUID()}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      writeAndSyncPrivateFile(fd, data);
    } finally {
      fs.closeSync(fd);
    }

    const lock = join(directory, `${tempPrefix}lock`);
    const owner = acquirePublicationLock(lock);
    if (!owner) return false;
    try {
      try {
        fs.linkSync(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && !(code && LINK_UNAVAILABLE.has(code)))
          throw error;
        const current = fs.lstatSync(target, { throwIfNoEntry: false });
        if (
          current
            ? !current.isFile() ||
              Date.now() - current.mtimeMs < PARTIAL_PUBLICATION_GRACE_MS ||
              !isIncomplete?.(target)
            : code === "EEXIST"
        )
          return false;
        fs.renameSync(temp, target);
      }
    } finally {
      fs.rmSync(owner, { force: true });
      removeEmptyLock(lock);
    }
    try {
      const dirFd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {}
    try {
      const cutoff = Date.now() - STALE_TEMP_MS;
      for (const name of fs.readdirSync(directory)) {
        if (
          !name.startsWith(tempPrefix) ||
          !/^\d+\.[0-9a-f-]{36}\.tmp$/.test(name.slice(tempPrefix.length))
        )
          continue;
        const stranded = join(directory, name);
        try {
          if (fs.lstatSync(stranded).mtimeMs < cutoff) fs.unlinkSync(stranded);
        } catch {}
      }
    } catch {}
    return true;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

function acquirePublicationLock(lock: string): string | undefined {
  const deadline = performance.now() + PUBLICATION_WAIT_MS;
  const owner = join(lock, `${process.pid}.${randomUUID()}`);
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.closeSync(fs.openSync(owner, "wx", 0o600));
        if (fs.readdirSync(lock).length === 1) return owner;
        fs.rmSync(owner, { force: true });
        removeEmptyLock(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          removeEmptyLock(lock);
          throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (current) {
        if (!current.isDirectory()) return;
        try {
          const owners = fs.readdirSync(lock);
          let abandoned =
            owners.length === 0 &&
            Date.now() - current.mtimeMs >= PARTIAL_PUBLICATION_GRACE_MS;
          for (const entry of owners) {
            const match = LOCK_OWNER.exec(entry);
            if (match?.[1] && !isPidAlive(Number(match[1]))) {
              fs.rmSync(join(lock, entry), { force: true });
              abandoned = true;
            }
          }
          if (abandoned) removeEmptyLock(lock);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    Atomics.wait(
      publicationWait,
      0,
      0,
      Math.min(PUBLICATION_POLL_MS, remaining),
    );
  }
}

function removeEmptyLock(lock: string): void {
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT")
      throw error;
  }
}

function writeAndSyncPrivateFile(fd: number, data: Uint8Array | string): void {
  fs.fchmodSync(fd, 0o600);
  fs.writeFileSync(fd, data);
  fs.fsyncSync(fd);
}

export function readPublishedFile<T>(
  read: () => T | null | undefined,
): T | null | undefined {
  const deadline = performance.now() + PUBLICATION_WAIT_MS;
  let result = read();
  while (result === null) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    Atomics.wait(
      publicationWait,
      0,
      0,
      Math.min(PUBLICATION_POLL_MS, remaining),
    );
    result = read();
  }
  return result;
}
