import { CALL_MODEL } from "../../models";
import { surfaceSources, type SurfaceMeta } from "../../surface";

export const meta: SurfaceMeta = {
  id: "suggest",
  title: "Composer suggestions (anthropic branch)",
  route: "call",
  model: CALL_MODEL,
  // titleGeneration.ts holds isLowSignalPrompt, which filters the prompts it learns from, and it reads machineMessages.ts.
  sources: surfaceSources(
    "suggest",
    "apps/server/convex/composerSuggestions.ts",
    "apps/server/convex/lib/anthropic.ts",
    "apps/server/convex/titleGeneration.ts",
    "packages/messages/src/machineMessages.ts",
  ),
  reps: { check: 5 },
  maxUsdPerRep: 0.06,
  criteria: null,
};
