import { spyOn } from "bun:test";
import * as media from "../lib/calls/walkie";

export function standInForWalkieMedia() {
  const blocked = spyOn(media, "walkieBlockedFor").mockReturnValue(null);
  const start = spyOn(media, "startBurst").mockResolvedValue(undefined);
  return {
    start,
    restore() {
      start.mockRestore();
      blocked.mockRestore();
    },
  };
}
