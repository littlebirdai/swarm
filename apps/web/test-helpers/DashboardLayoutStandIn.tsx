import type { ComponentProps } from "react";
import type { DashboardLayout } from "../components/DashboardLayout";

export function DashboardLayoutStandIn({
  children,
}: ComponentProps<typeof DashboardLayout>) {
  return <div data-shell>{children}</div>;
}
