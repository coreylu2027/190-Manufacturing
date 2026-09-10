"use client";

import Link from "next/link";
import { Check, ListTree, Wrench } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

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

const statusDotStyles: Record<OperationStatus, string> = {
  Planned: "bg-slate-400",
  Ready: "bg-emerald-500",
  "In Progress": "bg-blue-500",
  Blocked: "bg-amber-500",
  "Needs Rework": "bg-rose-500",
  Complete: "bg-violet-600",
};

function statusLabel(status: OperationStatus) {
  return status === "Complete" ? "Completed" : status;
}

function StatusDot({ status }: { status: OperationStatus }) {
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full shadow-sm", statusDotStyles[status])} aria-hidden>
      {status === "Complete" ? <Check className="size-3.5 text-white" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-white/90" />}
    </span>
  );
}

function FlowTile({
  node,
  step,
  current,
  onOpenOperation,
}: {
  node: OperationFlowNode;
  step: number;
  current: boolean;
  onOpenOperation: (operationId: number) => void;
}) {
  const classes = cn(
    "block h-[5.25rem] w-[6.5rem] shrink-0 rounded-xl border bg-card p-2.5 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    current ? "border-blue-500 bg-blue-50/60 ring-1 ring-blue-500/20" : "border-border",
    node.kind !== "qc" && "hover:border-primary/50 hover:bg-accent/30",
  );
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold text-muted-foreground">{step}</span>
        <StatusDot status={node.status} />
      </div>
      <p className="mt-0.5 truncate font-mono text-xs font-bold text-foreground">{node.label}</p>
      <p className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground" title={node.description}>{node.description}</p>
    </>
  );
  const ariaLabel = `${current ? "Current step, " : ""}${node.label}, ${node.description}, ${statusLabel(node.status)}`;

  if (node.kind === "operation" && node.operationId !== null) {
    const operationId = node.operationId;
    return (
      <button
        type="button"
        className={classes}
        aria-current={current ? "step" : undefined}
        aria-label={`Open ${ariaLabel}`}
        onClick={() => onOpenOperation(operationId)}
      >
        {content}
      </button>
    );
  }

  if (node.kind === "finishing" && node.finishingJobId !== null && node.requirementId !== null) {
    return (
      <Link
        href={`${WORKSPACE_ROUTES.fabrication}?requirementId=${node.requirementId}`}
        className={classes}
        aria-label={`Open ${ariaLabel}`}
      >
        {content}
      </Link>
    );
  }

  return <div className={cn(classes, "cursor-default")} aria-label={ariaLabel}>{content}</div>;
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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const currentTileRef = useRef<HTMLDivElement>(null);
  const stages = buildOperationFlow(operations, finishingStages);
  const tiles = stages.flatMap((stage, stageIndex) => stage.nodes.map((node) => ({
    node,
    step: stageIndex + 1,
  })));
  const currentTileIndex = tiles.findIndex(({ node }) => node.operationId === currentOperationId);
  const currentTile = tiles[currentTileIndex] ?? tiles[0];
  const currentOperation = operations.find((operation) => operation.id === currentTile?.node.operationId);
  const currentCategory = currentOperation?.workType
    ?? (currentTile?.node.kind === "qc" ? "Quality" : "Finishing");
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || currentTileIndex < 0) return;

    const positionCurrentTile = () => {
      const tile = currentTileRef.current;
      if (!tile) return;

      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const target = currentTileIndex === 0
        ? 0
        : currentTileIndex === tiles.length - 1
          ? maxScroll
          : tile.offsetLeft - (scroller.clientWidth - tile.clientWidth) / 2;
      const inlineScrollBehavior = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = "auto";
      scroller.scrollLeft = Math.max(0, Math.min(maxScroll, target));
      scroller.style.scrollBehavior = inlineScrollBehavior;
    };

    positionCurrentTile();
    const frame = requestAnimationFrame(positionCurrentTile);
    const resizeObserver = new ResizeObserver(positionCurrentTile);
    resizeObserver.observe(scroller);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [currentTileIndex, tiles.length]);

  if (!currentTile) return null;

  return (
    <div>
      <div ref={scrollerRef} className="operation-flow-scrollbar min-w-0 overflow-x-auto overscroll-x-contain">
        <div className="flex min-w-max gap-2 pb-2 pt-1">
          {tiles.map(({ node, step }) => (
            <div key={node.key} ref={node.operationId === currentOperationId ? currentTileRef : undefined}>
              <FlowTile node={node} step={step} current={node.operationId === currentOperationId} onOpenOperation={onOpenOperation} />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/30 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-base font-bold text-foreground">{currentTile.node.label}</p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground" title={currentTile.node.description}>{currentTile.node.description}</p>
          </div>
          <Badge variant="outline" className={cn("shrink-0 font-semibold", statusStyles[currentTile.node.status])}>{statusLabel(currentTile.node.status)}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><ListTree className="size-3.5" />Step {currentTile.step} of {stages.length}</span>
          <span className="flex items-center gap-1.5"><Wrench className="size-3.5" />{currentCategory}</span>
        </div>
      </div>
    </div>
  );
}
