"use client";

import type { LucideIcon } from "lucide-react";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatShortDateTime } from "@/lib/date-format";
import type { ProductionStatus } from "@/lib/production-status";
import type { QualityFailureSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export const PartModelPreview = dynamic(
  () => import("@/components/part-model-preview").then((module) => module.PartModelPreview),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[22rem] rounded-xl sm:h-[26rem]" />,
  },
);

const statusStyles: Record<ProductionStatus, string> = {
  Planned: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-400/30 dark:bg-slate-400/15 dark:text-slate-200",
  Ready: "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200",
  "In Progress": "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-400/30 dark:bg-blue-400/15 dark:text-blue-200",
  Blocked: "border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-100",
  "QC Pending": "border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-400/30 dark:bg-cyan-400/15 dark:text-cyan-200",
  "Finishing Pending": "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-200",
  "Off the Shelf": "border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-400/30 dark:bg-teal-400/15 dark:text-teal-200",
  Complete: "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-400/30 dark:bg-violet-400/15 dark:text-violet-200",
};

export function StatusBadge({ status }: { status: ProductionStatus }) {
  return <Badge variant="outline" className={cn("font-semibold", statusStyles[status])}>{status}</Badge>;
}

export function StatusCell({ value }: { value: ProductionStatus }) {
  return <div className="flex h-full items-center"><StatusBadge status={value} /></div>;
}

export function QualityFailureCallout({ failure }: { failure: QualityFailureSummary | null }) {
  if (!failure) return null;
  return (
    <section className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-950 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-50">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-[.14em] text-rose-800 dark:text-rose-300">Previous QC failure</h3>
        <p className="text-xs text-rose-700 dark:text-rose-300">{failure.rejectedQuantity ? `${failure.rejectedQuantity} rejected · ` : ""}{formatShortDateTime(failure.reviewedAt)}{failure.reviewedBy ? ` · ${failure.reviewedBy}` : ""}</p>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{failure.notes || "No failure reason was recorded."}</p>
    </section>
  );
}

/** The KPI tiles beside each workspace heading. */
export function StatTiles({ items, className, tileMinWidth = "min-w-32" }: {
  items: Array<{ label: string; value: number; icon: LucideIcon; tone: string }>;
  className: string;
  tileMinWidth?: string;
}) {
  return (
    <div className={className}>
      {items.map(({ label, value, icon: Icon, tone }) => (
        <div key={label} className={cn("flex", tileMinWidth, "items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm")}>
          <div className={cn("grid size-8 place-items-center rounded-lg", tone)}><Icon className="size-4" /></div>
          <div><div className="text-lg font-bold leading-none">{value}</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div></div>
        </div>
      ))}
    </div>
  );
}

/** The centered icon, heading and message shown in place of a table that has nothing to show. */
export function EmptyState({ icon: Icon, iconClassName, title, titleAs: Title = "h2", message, messageClassName, className = "min-h-80", children }: {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  titleAs?: "h2" | "h3";
  message: ReactNode;
  messageClassName?: string;
  className?: string;
  /** An optional action button below the message. */
  children?: ReactNode;
}) {
  return (
    <div className={cn("grid", className, "place-items-center p-6 text-center")}>
      <div><Icon className={cn("mx-auto mb-3", iconClassName)} /><Title className="font-semibold">{title}</Title><p className={cn("mt-1", messageClassName, "text-sm text-muted-foreground")}>{message}</p>{children}</div>
    </div>
  );
}
