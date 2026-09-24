"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, Search, Wrench } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CORRECTION_FIELD_LABELS, type EngineeringCorrection } from "@/lib/engineering-overrides";

type KindFilter = "all" | EngineeringCorrection["kind"];
const KIND_LABELS: Record<KindFilter, string> = { all: "All corrections", field: "Field values", file: "Replacement files", off_the_shelf: "Off-the-shelf parts" };

async function fetchCorrections(): Promise<EngineeringCorrection[]> {
  const response = await fetch("/api/admin/engineering-corrections", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to load corrections");
  return body.corrections;
}

function valueText(correction: EngineeringCorrection, value: unknown) {
  if (correction.kind === "off_the_shelf") return value === true ? "Bought, not manufactured" : "Manufactured";
  if (correction.kind === "file") return value && typeof value === "object" && "name" in value ? String(value.name) : "None";
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function rowsFor(corrections: EngineeringCorrection[]) {
  return corrections.map((correction) => ({
    key: `${correction.kind}|${correction.field}|${correction.part_id}|${correction.requirement_id ?? "part"}`,
    part: correction.part_number ?? `Part #${correction.part_id}`,
    name: correction.part_name ?? "",
    scope: correction.requirement_id === null ? "Every requirement for this part" : `${correction.assembly_number ?? "Unassigned"}${correction.source_document ? ` · ${correction.source_document}` : ""}`,
    inactive: correction.requirement_id !== null && correction.active_in_bom === false,
    field: CORRECTION_FIELD_LABELS[correction.field] ?? correction.field,
    corrected: valueText(correction, correction.value),
    onshape: valueText(correction, correction.synced_value),
    by: correction.updated_by_name ?? "—",
    at: correction.updated_at,
    reason: correction.reason,
    kind: correction.kind,
  }));
}

function downloadCsv(rows: ReturnType<typeof rowsFor>) {
  const header = ["Part", "Name", "Applies to", "Field", "Corrected value", "Onshape value", "Adjusted by", "Adjusted at", "Reason"];
  const quote = (value: string) => `"${value.replaceAll("\"", "\"\"")}"`;
  const lines = [header, ...rows.map((row) => [row.part, row.name, row.scope, row.field, row.corrected, row.onshape, row.by, row.at ?? "", row.reason])]
    .map((line) => line.map((value) => quote(String(value))).join(","));
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `onshape-corrections-${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

/** Every active correction, so the CAD team can fix Onshape and let the corrections retire. */
export function EngineeringCorrectionsReport() {
  const query = useQuery({ queryKey: ["engineering-corrections"], queryFn: fetchCorrections });
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const rows = useMemo(() => rowsFor(query.data ?? []), [query.data]);
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return rows.filter((row) => (kind === "all" || row.kind === kind)
      && (!term || [row.part, row.name, row.scope, row.field, row.corrected, row.onshape, row.by, row.reason].join(" ").toLocaleLowerCase().includes(term)));
  }, [kind, rows, search]);

  return (
    <div className="mt-6 overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/25 p-3 md:p-4">
        <div className="min-w-52 flex-1">
          <h2 className="flex items-center gap-2 font-semibold"><Wrench className="size-4 text-primary" />Onshape corrections</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Values the shop uses instead of Onshape. Fix these in CAD; field corrections retire automatically once the sync delivers the same value.</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, field, reason…" />
        </div>
        <Select value={kind} onValueChange={(value) => setKind((value ?? "all") as KindFilter)}>
          <SelectTrigger className="h-9 w-full bg-card sm:w-52"><SelectValue>{KIND_LABELS[kind]}</SelectValue></SelectTrigger>
          <SelectContent>{(Object.keys(KIND_LABELS) as KindFilter[]).map((value) => <SelectItem key={value} value={value}>{KIND_LABELS[value]}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!visible.length} onClick={() => downloadCsv(visible)}><Download />Export CSV</Button>
      </div>
      {query.isPending ? (
        <div className="space-y-3 p-5">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</div>
      ) : query.isError ? (
        <p className="p-5 text-sm text-destructive">{query.error.message}</p>
      ) : visible.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">{rows.length ? "No corrections match." : "No active corrections. The shop is using Onshape data as synced."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-muted text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr>{["Part", "Applies to", "Field", "Corrected", "Onshape", "Adjusted", "Reason"].map((label) => <th key={label} className="px-4 py-2.5">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((row) => (
                <tr key={row.key} className="align-top">
                  <td className="px-4 py-3"><p className="font-mono text-xs font-bold text-primary">{row.part}</p><p className="mt-0.5 text-xs text-muted-foreground">{row.name}</p></td>
                  <td className="px-4 py-3 text-xs">{row.scope}{row.inactive && <span className="ml-1 text-muted-foreground">(inactive)</span>}</td>
                  <td className="px-4 py-3 font-semibold">{row.field}</td>
                  <td className="max-w-56 break-words px-4 py-3">{row.corrected}</td>
                  <td className="max-w-56 break-words px-4 py-3 text-muted-foreground">{row.onshape}</td>
                  <td className="px-4 py-3 text-xs">{row.by}{row.at && <span className="block text-muted-foreground">{new Date(row.at).toLocaleDateString()}</span>}</td>
                  <td className="max-w-64 whitespace-pre-wrap break-words px-4 py-3 text-xs text-muted-foreground">{row.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
