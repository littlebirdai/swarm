import {
  PASSAGE_TABLE,
  SLIDE_ANCHORS,
  passageRow,
  solvePassages,
} from "./timeline";

export function passageTables(device: "desktop" | "mobile") {
  const mobile = device === "mobile";
  const solved: Record<string, string> = {};
  const kept: Record<string, string> = {};
  for (const anchor of SLIDE_ANCHORS[device]) {
    const key = `${mobile ? "m" : "d"}:${anchor}`;
    solved[key] = passageRow(solvePassages(mobile, anchor));
    kept[key] = PASSAGE_TABLE[key];
  }
  return { solved, kept };
}
