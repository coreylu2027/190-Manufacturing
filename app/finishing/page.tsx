import { WorkspacePage } from "@/components/workspace-page";

export const dynamic = "force-dynamic";

export default async function FinishingPage({
  searchParams,
}: {
  searchParams: Promise<{ requirementId?: string | string[] }>;
}) {
  const value = (await searchParams).requirementId;
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  const initialFinishingRequirementId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  return <WorkspacePage workspaceView="fabrication" initialFinishingRequirementId={initialFinishingRequirementId} />;
}
