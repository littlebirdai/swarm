import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";

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
const publicationWait = new Int32Array(new SharedArrayBuffer(4));

export function publishPrivateFile(
  file: string,
  data: Uint8Array | string,
): boolean {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    writeAndSyncPrivateFile(fd, data);

    let published = true;
    try {
      fs.linkSync(temp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      published = false;
      if (code && LINK_UNAVAILABLE.has(code)) {
        let destination: number | undefined;
        try {
          destination = fs.openSync(file, "wx", 0o600);
        } catch (openError) {
          if ((openError as NodeJS.ErrnoException).code !== "EEXIST")
            throw openError;
        }
        if (destination !== undefined) {
          writeAndSyncPrivateFile(destination, data);
          published = true;
        }
      } else if (code !== "EEXIST") throw err;
    }
    try {
      const dirFd = fs.openSync(dirname(file), "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
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
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readPublishedFile<T>(read: () => T | null): T | null {
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
