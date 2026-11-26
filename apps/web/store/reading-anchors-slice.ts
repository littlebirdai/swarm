import { asyncAction, sync } from "./mutativeMiddleware";
import type { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { SavedReadingAnchor } from "../hooks/use-saved-reading-anchor";

type SaveArgs = FunctionArgs<typeof api.conversationReadAnchors.save>;

export type ReadingAnchorsSlice = {
  beginSavedReadingAnchor: (id: Id<"conversations">) => Promise<string | null>;
  saveSavedReadingAnchor: (
    args: SaveArgs,
  ) => Promise<FunctionReturnType<typeof api.conversationReadAnchors.save>>;
  dropSavedReadingAnchor: (id: string) => void;
};

export function createReadingAnchorsSlice(): ReadingAnchorsSlice {
  return {
    beginSavedReadingAnchor: asyncAction(function (
      _id: Id<"conversations">,
    ) {}),
    saveSavedReadingAnchor: asyncAction(function (_args: SaveArgs) {}),
    dropSavedReadingAnchor: sync(function (
      this: { sessionReadAnchors: Record<string, SavedReadingAnchor> },
      id: string,
    ) {
      delete this.sessionReadAnchors[id];
    }),
  } as unknown as ReadingAnchorsSlice;
}
