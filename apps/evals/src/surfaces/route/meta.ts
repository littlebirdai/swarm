import { CALL_MODEL } from "../../models";
import { surfaceSources, type SurfaceMeta } from "../../surface";

export const meta: SurfaceMeta = {
  id: "route",
  title: "The semantic router: which role an unplaced request belongs to",
  route: "call",
  model: CALL_MODEL,
  sources: surfaceSources(
    "route",
    "apps/server/convex/lib/orgRouter.ts",
    "apps/server/convex/orgRoute.ts",
    "packages/org/src/orgRoute.ts",
    "apps/server/convex/lib/anthropic.ts",
  ),
  reps: { check: 5 },
  // One cheap call over a roster of a dozen roles, plus the judge.
  maxUsdPerRep: 0.03,
  criteria:
    "names the role whose charter or area covers the request, cites that charter or area in its reason, and is sure only when one role plainly covers it",
};
