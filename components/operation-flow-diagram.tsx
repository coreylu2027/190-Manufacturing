import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buildOperationFlow, type OperationFlowNode } from "@/lib/operation-flow";
import type { FinishingStage, ManufacturingOperation, OperationStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WORKSPACE_ROUTES } from "@/lib/workspace-routes";

const statusStyles: Record<OperationStatus, string> = {
  Planned: "border-slate-200 bg-slate-100 text-slate-700",
  Ready: "border-emerald-200 bg-emerald-100 text-emerald-800",
  "In Progress": "border-blue-200 bg-blue-100 text-blue-800",
  Blocked: "border-amber-200 bg-amber-100 text-amber-900",
  "Needs Rework": "border-rose-200 bg-rose-100 text-rose-800",
  Complete: "border-violet-200 bg-violet-100 text-violet-800",
};

function statusLabel(status: OperationStatus) {
  return status === "Complete" ? "Completed" : status;
}

function NodeContent({ node, current }: { node: OperationFlowNode; current: boolean }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-bold text-foreground">{node.label}</span>
        {current && <Badge className="h-5 px-1.5 text-[9px] uppercase tracking-wider">Current</Badge>}
      </div>
      <p className="mt-1.5 truncate text-xs font-semibold text-muted-foreground" title={node.description}>{node.description}</p>
      <Badge variant="outline" className={cn("mt-2 font-semibold", statusStyles[node.status])}>{statusLabel(node.status)}</Badge>
    </>
  );
}

export function OperationFlowDiagram({
  operations,
  finishingStages,
  currentOperationId,
  onOpenOperation,
}: {
  operations: ManufacturingOperation[];
  finishingStages: FinishingStage[];
  currentOperationId: number;
  onOpenOperation: (operationId: number) => void;
}) {
  const stages = buildOperationFlow(operations, finishingStages);

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-center py-1">
        {stages.map((stage, stageIndex) => (
          <div key={stage.key} className="flex items-center">
            {stageIndex > 0 && <ChevronRight aria-hidden className="mx-2 size-5 shrink-0 text-muted-foreground/60" />}
            <div className="flex flex-col gap-2">
              {stage.nodes.map((node) => {
                const current = node.operationId === currentOperationId;
                const classes = cn(
                  "block w-40 rounded-xl border bg-card p-3 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  current && "border-primary ring-2 ring-primary/25",
                  node.kind !== "qc" && "hover:border-primary/50 hover:bg-accent/30",
                );
                const content = <NodeContent node={node} current={current} />;

                if (node.kind === "operation" && node.operationId !== null) {
                  return (
                    <button
                      key={node.key}
                      type="button"
                      className={classes}
                      aria-current={current ? "step" : undefined}
                      aria-label={`Open ${node.label}, ${node.description}, ${statusLabel(node.status)}`}
                      onClick={() => onOpenOperation(node.operationId as number)}
                    >
                      {content}
                    </button>
                  );
                }

                if (node.kind === "finishing" && node.finishingJobId !== null && node.requirementId !== null) {
                  return (
                    <Link
                      key={node.key}
                      href={`${WORKSPACE_ROUTES.fabrication}?requirementId=${node.requirementId}`}
                      className={classes}
                      aria-label={`Open finishing, ${node.description}, ${statusLabel(node.status)}`}
                    >
                      {content}
                    </Link>
                  );
                }

                return <div key={node.key} className={cn(classes, "cursor-default")}>{content}</div>;
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
