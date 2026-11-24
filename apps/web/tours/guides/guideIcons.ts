// The mark each guided feature wears: the same icon its sidebar row draws.
import { Network, Waypoints, Compass, type LucideIcon } from "lucide-react";
import type { TeamFeatureKey } from "@codecast/policy/teamFeatures";

export function guideIcon(feature: TeamFeatureKey): LucideIcon {
  if (feature === "org") return Network;
  if (feature === "line") return Waypoints;
  return Compass;
}
