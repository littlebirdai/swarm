import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killIsolatedTmuxServer } from "../test-helpers/isolatedTmuxServer.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { tmuxRunAsync } from "../tmux.js";
import {
  physicalPaneKey,
  resolveTypingPane,
  writeTypingPane,
} from "./tmux-typing-pane.js";

afterAll(killIsolatedTmuxServer);

test.skipIf(!Bun.which("tmux"))(
  "guarded typing accepts an alias and refuses a respawned pane",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-tmux-typing-"));
    const name = "cc-daemon-typing-e2e";
    const target = `${name}:0.0`;
    try {
      const created = await tmuxRunAsync([
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        dir,
        "stty raw -echo; touch first.ready; exec cat > first.keys",
      ]);
      expect(created.status).toBe(0);
      await pollUntil(
        () => fs.existsSync(path.join(dir, "first.ready")),
        "first tty is ready",
      );
      const original = await resolveTypingPane(name);
      const alias = await resolveTypingPane(target);
      if (!original || !alias)
        throw new Error("Expected both targets to resolve");
      expect(physicalPaneKey(alias)).toBe(physicalPaneKey(original));

      const data = Buffer.from([...Array(520).fill(97), 0x1b, 0xc3, 0xa9]);
      expect(await writeTypingPane(target, original, [...data])).toBe(true);
      const first = path.join(dir, "first.keys");
      await pollUntil(
        () =>
          fs.statSync(first, { throwIfNoEntry: false })?.size === data.length,
        "all chunks reached the first pane",
      );
      expect(fs.readFileSync(first)).toEqual(data);

      const respawn = await tmuxRunAsync([
        "respawn-pane",
        "-k",
        "-t",
        target,
        "-c",
        dir,
        "stty raw -echo; touch second.ready; exec cat > second.keys",
      ]);
      expect(respawn.status).toBe(0);
      await pollUntil(
        () => fs.existsSync(path.join(dir, "second.keys")),
        "replacement tty is ready",
      );
      const replacement = await resolveTypingPane(target);
      if (!replacement) throw new Error("Expected the respawned pane");
      expect(replacement.paneId).toBe(original.paneId);
      expect(physicalPaneKey(replacement)).not.toBe(physicalPaneKey(original));
      expect(await writeTypingPane(target, original, [0x78])).toBe(false);
      expect(await writeTypingPane(target, replacement, [0x79])).toBe(true);
      const second = path.join(dir, "second.keys");
      await pollUntil(
        () => (fs.statSync(second, { throwIfNoEntry: false })?.size ?? 0) > 0,
        "a key reaches the replacement",
      );
      expect(fs.readFileSync(second).toString()).toBe("y");
    } finally {
      await tmuxRunAsync(["kill-session", "-t", name]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
