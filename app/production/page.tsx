import { WorkspacePage } from "@/components/workspace-page";

export const dynamic = "force-dynamic";

export default function ProductionPage() {
  return <WorkspacePage workspaceView="production" />;
}
