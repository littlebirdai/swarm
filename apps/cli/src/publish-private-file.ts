import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";

export function publishPrivateFile(
  file: string,
  data: Uint8Array | string,
): boolean {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    let published = true;
    try {
      fs.linkSync(temp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      published = false;
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
