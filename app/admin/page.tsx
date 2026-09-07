import { WorkspacePage } from "@/components/workspace-page";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <WorkspacePage workspaceView="admin" />;
}
