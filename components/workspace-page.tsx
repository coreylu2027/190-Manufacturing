import { redirect } from "next/navigation";

import { ManufacturingDashboard } from "@/components/manufacturing-dashboard";
import { getEffectiveAppUser, isAuthRequired, recordSiteVisit } from "@/lib/auth";
import { WORKSPACE_ROUTES, type WorkspaceView } from "@/lib/workspace-routes";

export async function WorkspacePage({ workspaceView }: { workspaceView: WorkspaceView }) {
  const authRequired = isAuthRequired();
  const user = await getEffectiveAppUser();

  if (authRequired && !user) redirect("/login");
  if (authRequired && user) await recordSiteVisit(user.id);
  if (authRequired && user && !user.approved) redirect("/pending");
  if (workspaceView === "admin" && user?.role !== "admin") redirect(WORKSPACE_ROUTES.operations);

  return <ManufacturingDashboard workspaceView={workspaceView} />;
}
