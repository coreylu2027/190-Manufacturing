"use client";

import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";

import { PROGRESS_STATUSES, type DocumentProgress } from "@/lib/document-progress";
import type { ProductionStatus } from "@/lib/production-status";
import { cn } from "@/lib/utils";

const SEGMENT: Record<ProductionStatus, string> = {
  Complete: "bg-violet-500",
  "Finishing Pending": "bg-orange-500",
  "QC Pending": "bg-cyan-500",
  "In Progress": "bg-blue-500",
  Ready: "bg-emerald-500",
  Blocked: "bg-amber-500",
  Planned: "bg-slate-300 dark:bg-slate-500",
  "Off the Shelf": "bg-teal-300 dark:bg-teal-600",
};
const SHORT: Record<ProductionStatus, string> = {
  Complete: "complete", "Finishing Pending": "finishing", "QC Pending": "QC", "In Progress": "in progress",
  Ready: "ready", Blocked: "blocked", Planned: "planned", "Off the Shelf": "off the shelf",
};

/** One card per synced-from document: how far its parts have progressed. Selecting a card filters the parts list. */
export function DocumentProgressPanel({ documents, selected, onSelect }: {
  documents: DocumentProgress[];
  selected: string | null;
  onSelect: (document: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  if (documents.length === 0) return null;
  const ready = documents.filter((document) => document.made.complete === document.made.total).length;

  return (
    <section className="mb-5 overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-3 border-b bg-muted/25 p-3 text-left md:p-4">
        <Layers className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Progress by source document</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {ready} of {documents.length} documents have every made part complete. Imported subassemblies count toward the document they were synced from. Select one to filter the parts list.
          </span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="grid gap-2 p-3 sm:grid-cols-2 md:p-4 xl:grid-cols-3 2xl:grid-cols-4">
          {documents.map((document) => {
            const active = selected === document.document;
            const statuses = PROGRESS_STATUSES.filter((status) => document.counts[status] > 0);
            return (
              <button key={document.document || "unsynced"} type="button" aria-pressed={active}
                onClick={() => onSelect(active ? null : document.document)}
                className={cn("min-w-0 rounded-xl border p-3 text-left transition hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary bg-primary/5" : "bg-background")}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-xs font-bold text-primary">{document.document || "Not synced"}</span>
                  <span className="shrink-0 text-sm font-bold">{document.percentComplete}%</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={document.assemblies.join(", ")}>
                  {document.assemblies.length === 1 ? document.assemblies[0] : `${document.assemblies.length} assemblies`}
                </p>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" role="img"
                  aria-label={statuses.map((status) => `${document.counts[status]} ${SHORT[status]}`).join(", ")}>
                  {statuses.map((status) => (
                    <span key={status} className={SEGMENT[status]} style={{ width: `${(document.counts[status] / document.total) * 100}%` }} />
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {document.made.total === 0 ? "Every part is bought off the shelf" : <>
                    <span className="font-semibold text-foreground">{document.made.complete}/{document.made.total}</span> made parts complete
                    {statuses.filter((status) => status !== "Complete").map((status) => ` · ${document.counts[status]} ${SHORT[status]}`).join("")}
                  </>}
                  {document.obsolete > 0 && ` · ${document.obsolete} obsolete not counted`}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
