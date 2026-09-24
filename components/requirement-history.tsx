"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, History, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { HistoryEntry, HistoryTone } from "@/lib/requirement-history";
import { cn } from "@/lib/utils";

const COLLAPSED_COUNT = 6;
const TONE_DOT: Record<HistoryTone, string> = {
  work: "bg-blue-500",
  "qc-pass": "bg-emerald-500",
  "qc-fail": "bg-rose-500",
  correction: "bg-amber-500",
  location: "bg-violet-500",
  note: "bg-slate-400",
  status: "bg-slate-500",
};

async function fetchHistory(requirementId: number): Promise<{ entries: HistoryEntry[] }> {
  const response = await fetch(`/api/requirements/${requirementId}/history`, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to load history");
  return body;
}

function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Timeline of recorded shop work, QC reviews, and corrections for one production requirement. */
export function RequirementHistory({ requirementId }: { requirementId: number }) {
  const [expanded, setExpanded] = useState(false);
  // Under "operations" so the invalidations that follow every shop write refresh it too.
  const query = useQuery({ queryKey: ["operations", "history", requirementId], queryFn: () => fetchHistory(requirementId) });
  const entries = query.data?.entries ?? [];
  const shown = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground"><History className="size-3.5" />History</h3>
        {query.isFetching && !query.isPending && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Refreshing history" />}
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">Loading history…</p>
      ) : query.isError ? (
        <p className="text-sm text-destructive">{query.error.message}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recorded changes yet. History covers work recorded in this app; Onshape sync updates aren’t listed.</p>
      ) : (
        <>
          <ol className="relative space-y-4 border-l pl-5">
            {shown.map((entry) => (
              <li key={entry.id} className="relative">
                <span aria-hidden="true" className={cn("absolute -left-[26px] top-1.5 size-2.5 rounded-full ring-4 ring-background", TONE_DOT[entry.tone])} />
                <p className="text-sm font-semibold leading-5">{entry.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {entry.actor ?? "Unknown"} · <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{relativeTime(entry.at)}</time>
                </p>
                {entry.details.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {entry.details.map((detail) => <li key={detail} className="break-words">{detail}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          {entries.length > COLLAPSED_COUNT && (
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setExpanded(!expanded)}>
              <ChevronDown className={cn("transition", expanded && "rotate-180")} />{expanded ? "Show less" : `Show all ${entries.length}`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
