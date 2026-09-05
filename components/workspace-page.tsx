import { redirect } from "next/navigation";

import { ManufacturingDashboard } from "@/components/manufacturing-dashboard";
import { getAppUser, recordSiteVisit } from "@/lib/auth";
import { WORKSPACE_ROUTES, type WorkspaceView } from "@/lib/workspace-routes";

export async function WorkspacePage({ workspaceView }: { workspaceView: WorkspaceView }) {
  const user = await getAppUser();

  if (!user) redirect("/login");
  await recordSiteVisit(user.id);
  if (!user.approved) redirect("/pending");
  if (workspaceView === "admin" && user?.role !== "admin") redirect(WORKSPACE_ROUTES.operations);

  return <ManufacturingDashboard workspaceView={workspaceView} />;
}
