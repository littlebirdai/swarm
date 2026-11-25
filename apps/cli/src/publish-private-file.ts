import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const LINK_UNAVAILABLE = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
  "EMLINK",
]);
const PUBLICATION_WAIT_MS = 100;
const PUBLICATION_POLL_MS = 5;
const STALE_TEMP_MS = 60_000;
const publicationWait = new Int32Array(new SharedArrayBuffer(4));

export function publishPrivateFile(
  file: string,
  data: Uint8Array | string,
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

    let published = true;
    try {
      fs.linkSync(temp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      published = false;
      if (code && LINK_UNAVAILABLE.has(code)) {
        let destination: number | undefined;
        try {
          destination = fs.openSync(target, "wx", 0o600);
        } catch (openError) {
          if ((openError as NodeJS.ErrnoException).code !== "EEXIST")
            throw openError;
        }
        if (destination !== undefined) {
          try {
            writeAndSyncPrivateFile(destination, data);
            published = true;
          } catch (writeError) {
            try {
              const created = fs.fstatSync(destination, { bigint: true });
              const current = fs.lstatSync(target, { bigint: true });
              if (created.dev === current.dev && created.ino === current.ino)
                fs.unlinkSync(target);
            } catch {}
            throw writeError;
          } finally {
            fs.closeSync(destination);
          }
        }
      } else if (code !== "EEXIST") throw err;
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
    return published;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
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
