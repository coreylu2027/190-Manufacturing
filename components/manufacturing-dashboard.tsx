"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Cloud,
  CloudOff,
  Download,
  Factory,
  FileText,
  LayoutList,
  LoaderCircle,
  MoreHorizontal,
  PackageCheck,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  OPERATION_STATUSES,
  type ManufacturingOperation,
  type OperationPatch,
  type OperationStatus,
  type OperationsResponse,
} from "@/lib/types";

ModuleRegistry.registerModules([AllCommunityModule]);

type QueueView = "available" | "mine" | "all";

const gridTheme = themeQuartz.withParams({
  accentColor: "#3159c6",
  backgroundColor: "#ffffff",
  borderColor: "#dce2ec",
  foregroundColor: "#172033",
  headerBackgroundColor: "#f7f9fc",
  headerTextColor: "#697386",
  rowHoverColor: "#f4f7fb",
  selectedRowBackgroundColor: "#eaf0ff",
  fontFamily: "var(--font-geist-sans), ui-sans-serif",
  fontSize: 13,
  headerFontSize: 11,
  headerFontWeight: 650,
  rowHeight: 52,
  headerHeight: 42,
  wrapperBorderRadius: 0,
  spacing: 6,
});

const statusStyles: Record<OperationStatus, string> = {
  Planned: "border-slate-200 bg-slate-100 text-slate-700",
  Ready: "border-emerald-200 bg-emerald-100 text-emerald-800",
  "In Progress": "border-blue-200 bg-blue-100 text-blue-800",
  Blocked: "border-amber-200 bg-amber-100 text-amber-900",
  "Needs Rework": "border-rose-200 bg-rose-100 text-rose-800",
  Complete: "border-violet-200 bg-violet-100 text-violet-800",
};

function StatusBadge({ status }: { status: OperationStatus }) {
  return <Badge variant="outline" className={cn("font-semibold", statusStyles[status])}>{status}</Badge>;
}

function StatusCell({ value }: { value: OperationStatus }) {
  return <div className="flex h-full items-center"><StatusBadge status={value} /></div>;
}

function ActionCell({ data, onOpen }: { data?: ManufacturingOperation; onOpen: (operation: ManufacturingOperation) => void }) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center justify-end">
      <Button size="sm" variant={data.status === "Ready" ? "default" : "ghost"} onClick={() => onOpen(data)}>
        {data.status === "Ready" ? "Start" : "Open"}<ChevronRight />
      </Button>
    </div>
  );
}

async function fetchOperations(): Promise<OperationsResponse> {
  const response = await fetch("/api/operations", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Unable to load manufacturing operations");
  }
  return response.json();
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function ManufacturingDashboard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [view, setView] = useState<QueueView>("available");
  const [machine, setMachine] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const query = useQuery({ queryKey: ["operations"], queryFn: fetchOperations });
  const userName = query.data?.user?.name ?? "Machinist";

  useEffect(() => {
    if (query.error instanceof Error && query.error.message === "AUTH_REQUIRED") router.replace("/login");
  }, [query.error, router]);

  const mutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: OperationPatch }) => {
      const response = await fetch(`/api/operations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Update failed");
      }
      return response.json();
    },
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ["operations"] });
      const previous = queryClient.getQueryData<OperationsResponse>(["operations"]);
      queryClient.setQueryData<OperationsResponse>(["operations"], (current) => {
        if (!current) return current;
        const now = new Date().toISOString();
        return {
          ...current,
          operations: current.operations.map((operation) => operation.id === id ? {
            ...operation,
            ...patch,
            machinist: patch.machinist ?? ((patch.status === "In Progress" || patch.status === "Complete") ? userName : operation.machinist),
            startedAt: patch.status === "In Progress" && !operation.startedAt ? now : operation.startedAt,
            completedAt: patch.status === "Complete" ? now : operation.completedAt,
          } : operation),
        };
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(["operations"], context.previous);
      toast.error(error instanceof Error ? error.message : "Unable to update operation");
    },
    onSuccess: (_data, variables) => {
      const message = variables.patch.status === "Complete" ? "Operation marked complete" : variables.patch.status === "In Progress" ? "Operation claimed and started" : "Operation updated";
      toast.success(message);
    },
    onSettled: () => {
      if (query.data?.source === "baserow") queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });

  const operations = useMemo(() => query.data?.operations ?? [], [query.data?.operations]);
  const selected = selectedId === null ? null : operations.find((operation) => operation.id === selectedId) ?? null;
  const machines = useMemo(() => [...new Set(operations.map((operation) => operation.machine))].sort(), [operations]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return operations.filter((operation) => {
      if (machine !== "all" && operation.machine !== machine) return false;
      if (view === "available" && operation.status !== "Ready") return false;
      if (view === "mine" && (operation.machinist !== userName || operation.status === "Complete")) return false;
      if (term && ![operation.partNumber, operation.partName, operation.assemblyNumber, operation.machine, operation.operationNumber].join(" ").toLowerCase().includes(term)) return false;
      return true;
    });
  }, [machine, operations, search, userName, view]);

  const stats = useMemo(() => ({
    ready: operations.filter((operation) => operation.status === "Ready").length,
    active: operations.filter((operation) => operation.status === "In Progress").length,
    attention: operations.filter((operation) => operation.status === "Blocked" || operation.status === "Needs Rework").length,
    complete: operations.filter((operation) => operation.status === "Complete").length,
  }), [operations]);

  const openOperation = (operation: ManufacturingOperation) => setSelectedId(operation.id);
  const updateOperation = (operation: ManufacturingOperation, patch: OperationPatch) => mutation.mutate({ id: operation.id, patch });

  const columnDefs = useMemo<ColDef<ManufacturingOperation>[]>(() => [
    { field: "partNumber", headerName: "PART", minWidth: 155, pinned: "left", cellClass: "font-mono font-semibold" },
    { field: "partName", headerName: "DESCRIPTION", minWidth: 230, flex: 1 },
    { field: "assemblyNumber", headerName: "ASSEMBLY", minWidth: 155 },
    { field: "quantity", headerName: "QTY", width: 78, filter: "agNumberColumnFilter" },
    { field: "operationNumber", headerName: "OP", width: 90, filter: true },
    { field: "machine", headerName: "MACHINE", minWidth: 175, filter: true },
    {
      field: "status", headerName: "STATUS", minWidth: 145, editable: true,
      cellEditor: "agSelectCellEditor", cellEditorParams: { values: [...OPERATION_STATUSES] }, cellRenderer: StatusCell,
    },
    { field: "machinist", headerName: "MACHINIST", minWidth: 140, editable: true, valueFormatter: ({ value }) => value || "—" },
    { headerName: "", width: 102, pinned: "right", sortable: false, filter: false, resizable: false, cellRenderer: ActionCell, cellRendererParams: { onOpen: openOperation } },
  ], []);

  const onCellValueChanged = (event: CellValueChangedEvent<ManufacturingOperation>) => {
    if (!event.data || event.newValue === event.oldValue) return;
    if (event.colDef.field === "status") updateOperation(event.data, { status: event.newValue as OperationStatus });
    if (event.colDef.field === "machinist") updateOperation(event.data, { machinist: String(event.newValue ?? "") });
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1800px] items-center gap-5 px-4 md:px-7">
          <div className="flex items-center gap-3 md:min-w-56">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm"><Factory className="size-5" /></div>
            <div><p className="text-sm font-bold leading-none">FRC 190</p><p className="mt-1 text-[10px] font-semibold uppercase tracking-[.17em] text-muted-foreground">Manufacturing OS</p></div>
          </div>
          <nav className="hidden h-full items-center gap-1 md:flex">
            <Button variant="ghost" className="h-10 bg-accent/70 text-primary"><LayoutList /> Operations</Button>
            <Button variant="ghost" className="h-10 text-muted-foreground"><PackageCheck /> Production</Button>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className={cn("hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium sm:flex", query.data?.source === "baserow" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900")}>
              {query.data?.source === "baserow" ? <Cloud className="size-3.5" /> : <CloudOff className="size-3.5" />}
              {query.data?.source === "baserow" ? "Baserow live" : "Demo data"}
            </div>
            <Button variant="ghost" size="icon" aria-label="Refresh operations" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw className={cn(query.isFetching && "animate-spin")} /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" className="h-10 gap-2 px-2 pr-3" />}>
                <Avatar size="sm"><AvatarFallback className="bg-primary/10 font-bold text-primary">{initials(userName)}</AvatarFallback></Avatar>
                <span className="hidden sm:inline">{userName}</span>
                <MoreHorizontal className="text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Signed in as<br /><span className="font-normal text-foreground">{query.data?.user?.email ?? userName}</span></DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<a href="/login" />}>Switch account</DropdownMenuItem>
                <DropdownMenuItem render={<a href="/auth/signout" />}>Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
        <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.12)]" /> Shop queue</div>
            <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Ready operations</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Filter to a machine, claim the next operation, and record who performed the work.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Ready", value: stats.ready, icon: CircleDot, tone: "text-emerald-700 bg-emerald-50" },
              { label: "In progress", value: stats.active, icon: Clock3, tone: "text-blue-700 bg-blue-50" },
              { label: "Attention", value: stats.attention, icon: TriangleAlert, tone: "text-amber-800 bg-amber-50" },
              { label: "Complete", value: stats.complete, icon: Check, tone: "text-violet-700 bg-violet-50" },
            ].map(({ label, value, icon: Icon, tone }) => (
              <div key={label} className="flex min-w-32 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm">
                <div className={cn("grid size-8 place-items-center rounded-lg", tone)}><Icon className="size-4" /></div>
                <div><div className="text-lg font-bold leading-none">{value}</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div></div>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
          <div className="border-b bg-muted/25 p-3 md:p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
              <div className="flex w-full overflow-x-auto rounded-lg bg-muted p-1 xl:w-auto">
                {([{ id: "available", label: "Available" }, { id: "mine", label: "My work" }, { id: "all", label: "All operations" }] as const).map((item) => (
                  <Button key={item.id} size="sm" variant="ghost" onClick={() => setView(item.id)} className={cn("min-w-fit", view === item.id && "bg-card text-foreground shadow-sm hover:bg-card")}>
                    {item.label}{item.id === "available" && <span className="ml-1 rounded bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-800">{stats.ready}</span>}
                  </Button>
                ))}
              </div>
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, assembly, operation…" />
              </div>
              <Select value={machine} onValueChange={(value) => setMachine(value ?? "all")}>
                <SelectTrigger className="h-9 w-full bg-card xl:w-56"><Wrench className="text-muted-foreground" /><SelectValue placeholder="All machines" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All machines</SelectItem>{machines.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><SlidersHorizontal className="size-3.5" /> {filtered.length} shown</div>
            </div>
          </div>

          {query.isLoading ? (
            <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>
          ) : query.isError ? (
            <div className="grid min-h-80 place-items-center p-6 text-center"><div><XCircle className="mx-auto mb-3 size-9 text-destructive" /><h2 className="font-semibold">Couldn’t load the queue</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
          ) : filtered.length === 0 ? (
            <div className="grid min-h-80 place-items-center p-6 text-center"><div><PackageCheck className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No operations match</h2><p className="mt-1 text-sm text-muted-foreground">Try another machine or clear the search.</p><Button variant="outline" className="mt-4" onClick={() => { setMachine("all"); setSearch(""); setView("all"); }}>Clear filters</Button></div></div>
          ) : (
            <>
              <div className="hidden h-[min(59vh,680px)] min-h-[430px] md:block">
                <AgGridReact<ManufacturingOperation>
                  theme={gridTheme}
                  rowData={filtered}
                  columnDefs={columnDefs}
                  defaultColDef={{ sortable: true, filter: false, resizable: true }}
                  getRowId={({ data }) => String(data.id)}
                  onCellValueChanged={onCellValueChanged}
                  onRowDoubleClicked={({ data }) => data && openOperation(data)}
                  pagination
                  paginationPageSize={25}
                  paginationPageSizeSelector={[10, 25, 50]}
                  stopEditingWhenCellsLoseFocus
                  animateRows
                />
              </div>
              <div className="divide-y md:hidden">
                {filtered.map((operation) => (
                  <button key={operation.id} onClick={() => openOperation(operation)} className="block w-full p-4 text-left transition hover:bg-muted/40">
                    <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-primary">{operation.partNumber}</p><h3 className="mt-1 font-semibold">{operation.partName}</h3></div><StatusBadge status={operation.status} /></div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"><span>{operation.operationNumber}</span><span className="flex items-center gap-1"><Wrench className="size-3" />{operation.machine}</span><span>Qty {operation.quantity}</span></div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-1 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Tip: status and machinist cells are directly editable in the grid.</span>
          <span>Last refreshed {query.data ? formatDate(query.data.syncedAt) : "—"}</span>
        </div>
      </section>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader className="border-b p-6 pr-14">
                <div className="mb-2 flex items-center gap-2"><StatusBadge status={selected.status} /><Badge variant="outline">{selected.operationNumber}</Badge></div>
                <SheetTitle className="text-2xl font-bold tracking-tight">{selected.partName}</SheetTitle>
                <SheetDescription className="font-mono text-xs font-semibold text-primary">{selected.partNumber}</SheetDescription>
              </SheetHeader>

              <div className="space-y-6 p-6">
                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Operation details</h3>
                  <div className="grid grid-cols-2 overflow-hidden rounded-xl border">
                    {[
                      ["Machine", selected.machine], ["Quantity", String(selected.quantity)],
                      ["Assembly", selected.assemblyNumber], ["Machinist", selected.machinist || "Unclaimed"],
                      ["Started", formatDate(selected.startedAt)], ["Completed", formatDate(selected.completedAt)],
                    ].map(([label, value], index) => <div key={label} className={cn("p-3", index % 2 === 0 && "border-r", index < 4 && "border-b")}><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}
                  </div>
                </section>

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Routing progress</h3>
                  <div className="flex items-center">
                    {(["Planned", "Ready", "In Progress", "Complete"] as OperationStatus[]).map((status, index, steps) => {
                      const statusIndex = steps.indexOf(selected.status);
                      const active = statusIndex >= index || selected.status === "Complete";
                      return <div key={status} className="flex flex-1 items-center last:flex-none"><div className={cn("grid size-7 place-items-center rounded-full border text-[10px] font-bold", active ? "border-primary bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{active ? <Check className="size-3.5" /> : index + 1}</div>{index < steps.length - 1 && <div className={cn("h-0.5 flex-1", statusIndex > index ? "bg-primary" : "bg-border")} />}</div>;
                    })}
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] font-semibold text-muted-foreground"><span>Planned</span><span>Ready</span><span>Working</span><span>Done</span></div>
                </section>

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Files & source</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      { label: "Drawing PDF", href: selected.drawingPdfUrl, icon: FileText },
                      { label: "STEP file", href: selected.stepUrl, icon: Download },
                      { label: "Onshape drawing", href: selected.drawingUrl, icon: ArrowUpRight },
                      { label: "BOM source", href: selected.onshapeUrl, icon: Cloud },
                    ].map(({ label, href, icon: Icon }) => href ? (
                      <a key={label} href={href} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border p-3 text-sm font-semibold transition hover:border-primary/40 hover:bg-accent/40"><div className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></div>{label}<ChevronRight className="ml-auto size-4 text-muted-foreground" /></a>
                    ) : (
                      <div key={label} className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm text-muted-foreground"><div className="grid size-8 place-items-center rounded-lg bg-muted"><Icon className="size-4" /></div>{label}<span className="ml-auto text-[10px] uppercase">Missing</span></div>
                    ))}
                  </div>
                </section>
              </div>

              <SheetFooter className="sticky bottom-0 border-t bg-card/95 p-4 backdrop-blur">
                {selected.status === "Ready" && <Button size="lg" className="h-11" onClick={() => updateOperation(selected, { status: "In Progress" })} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <CircleDot />} Claim & start operation</Button>}
                {selected.status === "In Progress" && <Button size="lg" className="h-11 bg-emerald-600 hover:bg-emerald-700" onClick={() => updateOperation(selected, { status: "Complete" })} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Check />} Mark operation complete</Button>}
                {(selected.status === "Blocked" || selected.status === "Needs Rework") && <Button size="lg" className="h-11" onClick={() => updateOperation(selected, { status: "In Progress" })}><RefreshCw /> Resume work</Button>}
                {selected.status === "Complete" && <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"><Check className="size-4" /> Completed by {selected.machinist || "machinist"}</div>}
                <Button variant="outline" onClick={() => setSelectedId(null)}>Close</Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
