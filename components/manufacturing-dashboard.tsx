"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  ArrowUpDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  ClipboardCopy,
  Clock3,
  Cloud,
  Code2,
  Download,
  Factory,
  FileText,
  LayoutList,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  PackageCheck,
  Paintbrush,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AdminDashboard } from "@/components/admin-dashboard";
import { FabricationDashboard } from "@/components/fabrication-dashboard";
import { NotificationInbox } from "@/components/notification-inbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { mergeVisibleSelection } from "@/lib/bulk-selection";
import { isShopName } from "@/lib/profile-name";
import { cn } from "@/lib/utils";
import { WORKSPACE_ROUTES, type WorkspaceView } from "@/lib/workspace-routes";
import {
  type CamHandoffPatch,
  type ManufacturingOperation,
  type OperationActionPatch,
  type OperationQuantityAction,
  type OperationStatus,
  type OperationWorkType,
  type OperationsResponse,
} from "@/lib/types";

ModuleRegistry.registerModules([AllCommunityModule]);

type QueueView = "available" | "mine" | "all";
type WorkTypeFilter = "all" | OperationWorkType;
type ProductionSort = "document" | "part" | "description" | "quantity" | "progress" | "status";

interface ProductionRequirement {
  key: string;
  partNumber: string;
  revision: string | null;
  partName: string;
  assemblyNumber: string;
  documentName: string | null;
  quantity: number;
  completedOperations: number;
  totalOperations: number;
  completedCamTasks: number;
  totalCamTasks: number;
  completedManufacturingOperations: number;
  totalManufacturingOperations: number;
  status: OperationStatus;
}

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

function ActionCell({ data, onOpen, user }: { data?: ManufacturingOperation; onOpen: (operation: ManufacturingOperation) => void; user: OperationsResponse["user"] }) {
  if (!data) return null;
  const claimable = ["Ready", "In Progress", "Needs Rework"].includes(data.status) && data.availableQuantity > 0;
  const stealable = isOperationStealable(data, user);
  return (
    <div className="flex h-full items-center justify-end">
      <Button size="sm" variant={claimable ? "default" : stealable ? "destructive" : "ghost"} onClick={() => onOpen(data)}>
        {claimable ? "Claim" : stealable ? "Steal" : "Open"}<ChevronRight />
      </Button>
    </div>
  );
}

async function fetchOperations(): Promise<OperationsResponse> {
  const response = await fetch("/api/operations", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (response.status === 403) {
    throw new Error("APPROVAL_REQUIRED");
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

function operationLabel(operation: Pick<ManufacturingOperation, "operationNumber" | "workType">) {
  return operation.workType === "CAM" ? `CAM for ${operation.operationNumber}` : operation.operationNumber;
}

function allocationForUser(operation: ManufacturingOperation, user: OperationsResponse["user"]) {
  if (!user) return { claimed: 0, completed: 0 };
  return operation.allocations.find((allocation) => allocation.userId === user.id)
    ?? operation.allocations.find((allocation) => allocation.name.toLocaleLowerCase() === user.name.toLocaleLowerCase())
    ?? { claimed: 0, completed: 0 };
}

function allocationBelongsToUser(allocation: ManufacturingOperation["allocations"][number], user: OperationsResponse["user"]) {
  if (!user) return false;
  return allocation.userId === user.id || allocation.name.toLocaleLowerCase() === user.name.toLocaleLowerCase();
}

function otherClaimants(operation: ManufacturingOperation, user: OperationsResponse["user"]) {
  return operation.allocations.filter((allocation) => allocation.claimed > 0 && !allocationBelongsToUser(allocation, user));
}

function isOperationStealable(operation: ManufacturingOperation, user: OperationsResponse["user"]) {
  return ["Ready", "In Progress", "Needs Rework"].includes(operation.status)
    && operation.availableQuantity === 0
    && otherClaimants(operation, user).length > 0;
}

function isOperationClaimable(operation: ManufacturingOperation) {
  return ["Ready", "In Progress", "Needs Rework"].includes(operation.status) && operation.availableQuantity > 0;
}

type BulkAction = Extract<OperationQuantityAction, "claim" | "complete">;

function bulkActionPlan(operation: ManufacturingOperation, user: OperationsResponse["user"], view: QueueView) {
  const claimedQuantity = allocationForUser(operation, user).claimed;
  const claimable = isOperationClaimable(operation);
  if (view === "available") return claimable ? { action: "claim" as const, quantity: operation.availableQuantity } : null;
  if (view === "mine") return claimedQuantity > 0 ? { action: "complete" as const, quantity: claimedQuantity } : null;
  if (operation.status === "Ready" && claimable) return { action: "claim" as const, quantity: operation.availableQuantity };
  if (claimedQuantity > 0) return { action: "complete" as const, quantity: claimedQuantity };
  return claimable ? { action: "claim" as const, quantity: operation.availableQuantity } : null;
}

const quantityActionCopy: Record<OperationQuantityAction, { title: string; button: string; success: string }> = {
  claim: { title: "Claim parts", button: "Claim", success: "Parts claimed" },
  release: { title: "Release claimed parts", button: "Release", success: "Claim released" },
  complete: { title: "Mark parts complete", button: "Complete", success: "Parts marked complete" },
  undo_complete: { title: "Undo completed parts", button: "Undo completion", success: "Completion undone" },
};

const inverseQuantityAction: Record<OperationQuantityAction, OperationQuantityAction> = {
  claim: "release",
  release: "claim",
  complete: "undo_complete",
  undo_complete: "complete",
};

function requirementStatus(operations: ManufacturingOperation[]): OperationStatus {
  if (operations.every((operation) => operation.status === "Complete")) return "Complete";
  if (operations.some((operation) => operation.status === "Blocked")) return "Blocked";
  if (operations.some((operation) => operation.status === "Needs Rework")) return "Needs Rework";
  if (operations.some((operation) => operation.status === "In Progress")) return "In Progress";
  if (operations.some((operation) => operation.status === "Ready")) return "Ready";
  return "Planned";
}

function ProductionOverview({
  operations,
  isLoading,
  isError,
  errorMessage,
  onRetry,
}: {
  operations: ManufacturingOperation[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | OperationStatus>("all");
  const [sort, setSort] = useState<ProductionSort>("document");
  const requirements = useMemo<ProductionRequirement[]>(() => {
    const grouped = new Map<string, ManufacturingOperation[]>();

    for (const operation of operations) {
      const key = `${operation.assemblyNumber}|${operation.partNumber}|${operation.revision ?? ""}`;
      grouped.set(key, [...(grouped.get(key) ?? []), operation]);
    }

    return [...grouped.entries()].map(([key, routedOperations]) => {
        const first = routedOperations[0];
        return {
          key,
          partNumber: first.partNumber,
          revision: first.revision,
          partName: first.partName,
          assemblyNumber: first.assemblyNumber,
          documentName: first.documentName,
          quantity: first.quantity,
          completedOperations: routedOperations.filter((operation) => operation.status === "Complete").length,
          totalOperations: routedOperations.length,
          completedCamTasks: routedOperations.filter((operation) => operation.workType === "CAM" && operation.status === "Complete").length,
          totalCamTasks: routedOperations.filter((operation) => operation.workType === "CAM").length,
          completedManufacturingOperations: routedOperations.filter((operation) => operation.workType === "Manufacturing" && operation.status === "Complete").length,
          totalManufacturingOperations: routedOperations.filter((operation) => operation.workType === "Manufacturing").length,
          status: requirementStatus(routedOperations),
        };
      });
  }, [operations]);

  const visibleRequirements = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const statusOrder: Record<OperationStatus, number> = {
      Blocked: 0,
      "Needs Rework": 1,
      "In Progress": 2,
      Ready: 3,
      Planned: 4,
      Complete: 5,
    };
    const filtered = requirements.filter((requirement) => {
      if (status !== "all" && requirement.status !== status) return false;
      if (term && ![
        requirement.partNumber,
        requirement.revision,
        requirement.partName,
        requirement.assemblyNumber,
        requirement.documentName,
      ].join(" ").toLocaleLowerCase().includes(term)) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sort === "part") return a.partNumber.localeCompare(b.partNumber);
      if (sort === "description") return a.partName.localeCompare(b.partName) || a.partNumber.localeCompare(b.partNumber);
      if (sort === "quantity") return b.quantity - a.quantity || a.partNumber.localeCompare(b.partNumber);
      if (sort === "progress") {
        const progressDifference = (b.completedOperations / b.totalOperations) - (a.completedOperations / a.totalOperations);
        return progressDifference || a.partNumber.localeCompare(b.partNumber);
      }
      if (sort === "status") return statusOrder[a.status] - statusOrder[b.status] || a.partNumber.localeCompare(b.partNumber);
      return (a.documentName ?? "").localeCompare(b.documentName ?? "") || a.partNumber.localeCompare(b.partNumber);
    });
  }, [requirements, search, sort, status]);

  const summary = useMemo(() => ({
    total: requirements.length,
    complete: requirements.filter((requirement) => requirement.status === "Complete").length,
    active: requirements.filter((requirement) => requirement.status === "In Progress").length,
    attention: requirements.filter((requirement) => requirement.status === "Blocked" || requirement.status === "Needs Rework").length,
  }), [requirements]);

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-blue-500 shadow-[0_0_0_4px_rgba(59,130,246,.12)]" /> Production overview</div>
          <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Production requirements</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Track each part through its routed operations and see what is complete, active, or needs attention.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "Requirements", value: summary.total, icon: PackageCheck, tone: "text-slate-700 bg-slate-100" },
            { label: "In progress", value: summary.active, icon: Clock3, tone: "text-blue-700 bg-blue-50" },
            { label: "Attention", value: summary.attention, icon: TriangleAlert, tone: "text-amber-800 bg-amber-50" },
            { label: "Complete", value: summary.complete, icon: Check, tone: "text-violet-700 bg-violet-50" },
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
            <div className="min-w-52 xl:mr-auto">
              <h2 className="font-semibold">Routed parts</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Grouped by source document and part number.</p>
            </div>
            <div className="relative min-w-0 flex-1 xl:max-w-md">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, revision, assembly, document…" />
            </div>
            <Select value={status} onValueChange={(value) => setStatus((value ?? "all") as "all" | OperationStatus)}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-48"><SlidersHorizontal className="text-muted-foreground" /><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All statuses</SelectItem>{(["Planned", "Ready", "In Progress", "Blocked", "Needs Rework", "Complete"] as OperationStatus[]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={sort} onValueChange={(value) => setSort((value ?? "document") as ProductionSort)}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-52"><ArrowUpDown className="text-muted-foreground" /><SelectValue placeholder="Sort requirements" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="document">Source document</SelectItem>
                <SelectItem value="part">Part number</SelectItem>
                <SelectItem value="description">Description</SelectItem>
                <SelectItem value="quantity">Quantity: high to low</SelectItem>
                <SelectItem value="progress">Progress: high to low</SelectItem>
                <SelectItem value="status">Status: attention first</SelectItem>
              </SelectContent>
            </Select>
            <div className="whitespace-nowrap text-xs text-muted-foreground">{visibleRequirements.length} of {requirements.length} shown</div>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>
        ) : isError ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><XCircle className="mx-auto mb-3 size-9 text-destructive" /><h2 className="font-semibold">Couldn’t load production requirements</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">{errorMessage}</p><Button className="mt-4" onClick={onRetry}>Try again</Button></div></div>
        ) : requirements.length === 0 ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><PackageCheck className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No routed parts</h2><p className="mt-1 text-sm text-muted-foreground">Production requirements will appear after operations are added to an active routing.</p></div></div>
        ) : visibleRequirements.length === 0 ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><Search className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No requirements match</h2><p className="mt-1 text-sm text-muted-foreground">Try another status or clear the search.</p><Button variant="outline" className="mt-4" onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</Button></div></div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b bg-muted/20 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  <tr><th className="px-4 py-3">Part</th><th className="px-4 py-3">Revision</th><th className="px-4 py-3">Description</th><th className="px-4 py-3">Source document</th><th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3">Routing progress</th><th className="px-4 py-3">Status</th></tr>
                </thead>
                <tbody className="divide-y">
                  {visibleRequirements.map((requirement) => {
                    const percent = Math.round((requirement.completedOperations / requirement.totalOperations) * 100);
                    return (
                      <tr key={requirement.key} className="transition hover:bg-muted/30">
                        <td className="px-4 py-3 font-mono text-xs font-bold text-primary">{requirement.partNumber}</td>
                        <td className="px-4 py-3 font-mono text-xs font-semibold">{requirement.revision ?? "—"}</td>
                        <td className="px-4 py-3 font-semibold">{requirement.partName}</td>
                        <td className="px-4 py-3 font-mono text-xs">{requirement.documentName ?? "Not synced"}</td>
                        <td className="px-4 py-3 text-right font-semibold">{requirement.quantity}</td>
                        <td className="min-w-56 px-4 py-3"><div className="mb-1.5 flex justify-between text-xs"><span>Mfg {requirement.completedManufacturingOperations}/{requirement.totalManufacturingOperations}{requirement.totalCamTasks > 0 ? ` · CAM ${requirement.completedCamTasks}/${requirement.totalCamTasks}` : ""}</span><span className="font-semibold">{percent}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div></td>
                        <td className="px-4 py-3"><StatusBadge status={requirement.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="divide-y md:hidden">
              {visibleRequirements.map((requirement) => {
                const percent = Math.round((requirement.completedOperations / requirement.totalOperations) * 100);
                return (
                  <article key={requirement.key} className="p-4">
                    <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-primary">{requirement.partNumber}</p><h3 className="mt-1 font-semibold">{requirement.partName}</h3><p className="mt-1 font-mono text-[11px] text-muted-foreground">Rev {requirement.revision ?? "—"} · {requirement.documentName ?? "Document not synced"} · Qty {requirement.quantity}</p></div><StatusBadge status={requirement.status} /></div>
                    <div className="mt-3"><div className="mb-1.5 flex justify-between text-xs text-muted-foreground"><span>Mfg {requirement.completedManufacturingOperations}/{requirement.totalManufacturingOperations}{requirement.totalCamTasks > 0 ? ` · CAM ${requirement.completedCamTasks}/${requirement.totalCamTasks}` : ""}</span><span className="font-semibold text-foreground">{percent}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div></div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function ManufacturingDashboard({ workspaceView }: { workspaceView: WorkspaceView }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const operationsGridRef = useRef<AgGridReact<ManufacturingOperation>>(null);
  const [view, setView] = useState<QueueView>("available");
  const [workType, setWorkType] = useState<WorkTypeFilter>("all");
  const [machine, setMachine] = useState("all");
  const [sourceDocument, setSourceDocument] = useState("all");
  const [search, setSearch] = useState("");
  const [bulkSelectedIds, setBulkSelectedIds] = useState<number[]>([]);
  const [bulkActionDialogOpen, setBulkActionDialogOpen] = useState(false);
  const [bulkCamProgramPath, setBulkCamProgramPath] = useState("");
  const [bulkCamNotes, setBulkCamNotes] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [quantityDialog, setQuantityDialog] = useState<{ action: OperationQuantityAction; max: number } | null>(null);
  const [quantityDraft, setQuantityDraft] = useState("1");
  const [camCompletionOpen, setCamCompletionOpen] = useState(false);
  const [camHandoffEditOpen, setCamHandoffEditOpen] = useState(false);
  const [camCompletedBy, setCamCompletedBy] = useState("");
  const [camProgramPath, setCamProgramPath] = useState("");
  const [camNotes, setCamNotes] = useState("");
  const [stealDialogOpen, setStealDialogOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastInitial, setLastInitial] = useState("");

  const query = useQuery({ queryKey: ["operations"], queryFn: fetchOperations });
  const userName = query.data?.user?.name ?? "Machinist";

  useEffect(() => {
    if (query.error instanceof Error && query.error.message === "AUTH_REQUIRED") router.replace("/login");
    if (query.error instanceof Error && query.error.message === "APPROVAL_REQUIRED") router.replace("/pending");
  }, [query.error, router]);

  const mutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: OperationActionPatch; suppressUndo?: boolean; workType?: OperationWorkType }) => {
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
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update operation"),
    onSuccess: (data, variables) => {
      if (data.updated?.status) {
        queryClient.setQueryData<OperationsResponse>(["operations"], (current) => current ? {
          ...current,
          operations: current.operations.map((operation) => operation.id === variables.id ? { ...operation, ...data.updated } : operation),
        } : current);
      }
      if (variables.patch.action === "steal") {
        const stolenQuantity = data.displaced?.reduce((sum: number, claimant: { quantity: number }) => sum + claimant.quantity, 0) ?? 0;
        toast.success(`Production requirement stolen${stolenQuantity ? `: ${stolenQuantity} ${stolenQuantity === 1 ? "part" : "parts"}` : ""}`);
        const delivery = data.notificationDelivery;
        if (delivery && (delivery.emailsFailed > 0 || delivery.emailsSkipped > 0 || delivery.unmappedRecipients > 0)) {
          toast.warning("The claim changed, but one or more email alerts could not be delivered. The website alert was kept when possible.");
        }
        setStealDialogOpen(false);
      } else {
        const quantityPatch = variables.patch;
        const copy = quantityActionCopy[quantityPatch.action];
        const unitLabel = variables.workType === "CAM" ? "CAM task" : `${quantityPatch.quantity} ${quantityPatch.quantity === 1 ? "part" : "parts"}`;
        toast.success(`${copy.success}: ${unitLabel}`, variables.suppressUndo || variables.workType === "CAM" ? undefined : {
          action: {
            label: "Undo",
            onClick: () => mutation.mutate({
              id: variables.id,
              patch: { action: inverseQuantityAction[quantityPatch.action], quantity: quantityPatch.quantity },
              suppressUndo: true,
              workType: variables.workType,
            }),
          },
        });
      }
      setQuantityDialog(null);
      setCamCompletionOpen(false);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });

  const bulkActionMutation = useMutation({
    mutationFn: async ({
      action,
      items,
      programPath,
      notes,
    }: {
      action: BulkAction;
      items: { id: number; quantity: number; workType: OperationWorkType }[];
      programPath: string;
      notes: string;
    }) => {
      const results = await Promise.allSettled(items.map(async (item) => {
        const response = await fetch(`/api/operations/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            quantity: item.quantity,
            ...(action === "complete" && item.workType === "CAM" ? {
              ...(programPath ? { programPath } : {}),
              notes,
            } : {}),
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? (action === "claim" ? "Claim failed" : "Completion failed"));
        return { item, updated: body.updated as Partial<ManufacturingOperation> | undefined };
      }));
      const succeeded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failed = results.length - succeeded.length;
      if (succeeded.length === 0) {
        const firstFailure = results.find((result) => result.status === "rejected");
        throw new Error(firstFailure?.status === "rejected" && firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : `Unable to ${action} selected operations`);
      }
      return { action, succeeded, failed };
    },
    onSuccess: ({ action, succeeded, failed }) => {
      const updates = new Map(succeeded.map(({ item, updated }) => [item.id, updated]));
      queryClient.setQueryData<OperationsResponse>(["operations"], (current) => current ? {
        ...current,
        operations: current.operations.map((operation) => updates.has(operation.id) ? { ...operation, ...updates.get(operation.id) } : operation),
      } : current);
      const workUnits = succeeded.reduce((total, result) => total + result.item.quantity, 0);
      const actionLabel = action === "claim" ? "Claimed" : "Completed";
      if (failed > 0) toast.warning(`${actionLabel} ${workUnits} ${workUnits === 1 ? "work unit" : "work units"} across ${succeeded.length} operations; ${failed} failed.`);
      else toast.success(`${actionLabel} ${workUnits} ${workUnits === 1 ? "work unit" : "work units"} across ${succeeded.length} operations.`);
      setBulkActionDialogOpen(false);
      setBulkSelectedIds([]);
      operationsGridRef.current?.api.deselectAll();
    },
    onError: (error, variables) => toast.error(error instanceof Error ? error.message : `Unable to ${variables.action} selected operations`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });

  const camHandoffMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: CamHandoffPatch }) => {
      const response = await fetch(`/api/operations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to update the CAM handoff");
      return body;
    },
    onSuccess: () => {
      toast.success("CAM handoff updated");
      setCamHandoffEditOpen(false);
      queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update the CAM handoff"),
  });

  const profileMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastInitial }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to update profile");
      return body;
    },
    onSuccess: (body) => {
      queryClient.setQueryData<OperationsResponse>(["operations"], (current) => current ? { ...current, user: body.user } : current);
      queryClient.invalidateQueries({ queryKey: ["operations"] });
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      setProfileOpen(false);
      toast.success(`Shop name updated to ${body.user.name}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update profile"),
  });

  const operations = useMemo(() => query.data?.operations ?? [], [query.data?.operations]);
  const selected = selectedId === null ? null : operations.find((operation) => operation.id === selectedId) ?? null;
  const selectedCamHandoff = selected?.workType === "CAM" ? {
    operationId: selected.id,
    status: selected.status,
    completedBy: selected.machinist,
    programPath: selected.camProgramPath,
    notes: selected.camNotes,
  } : selected?.camDependency ?? null;
  const selectedAllocation = selected ? allocationForUser(selected, query.data?.user ?? null) : { claimed: 0, completed: 0 };
  const selectedOtherClaimants = selected ? otherClaimants(selected, query.data?.user ?? null) : [];
  const machines = useMemo(() => [...new Set(operations.map((operation) => operation.machine))].sort(), [operations]);
  const sourceDocuments = useMemo(() => [...new Set(operations.flatMap((operation) => operation.documentName ? [operation.documentName] : []))].sort(), [operations]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return operations.filter((operation) => {
      if (workType !== "all" && operation.workType !== workType) return false;
      if (machine !== "all" && operation.machine !== machine) return false;
      if (sourceDocument === "missing" && operation.documentName) return false;
      if (sourceDocument !== "all" && sourceDocument !== "missing" && operation.documentName !== sourceDocument) return false;
      const allocation = allocationForUser(operation, query.data?.user ?? null);
      const claimable = isOperationClaimable(operation);
      if (view === "available" && !claimable && !isOperationStealable(operation, query.data?.user ?? null)) return false;
      if (view === "mine" && allocation.claimed === 0) return false;
      if (term && ![operation.partNumber, operation.revision, operation.partName, operation.documentName, operation.material, operation.machine, operation.operationNumber, operation.workType, operation.camProgramPath].join(" ").toLowerCase().includes(term)) return false;
      return true;
    });
  }, [machine, operations, query.data?.user, search, sourceDocument, view, workType]);

  const bulkItems = useMemo(() => operations.flatMap((operation) => {
    if (!bulkSelectedIds.includes(operation.id)) return [];
    const plan = bulkActionPlan(operation, query.data?.user ?? null, view);
    return plan ? [{ operation, ...plan }] : [];
  }), [bulkSelectedIds, operations, query.data?.user, view]);
  const selectedBulkActions = new Set(bulkItems.map((item) => item.action));
  const bulkAction = selectedBulkActions.size === 1 ? [...selectedBulkActions][0] : null;
  const hasMixedBulkActions = selectedBulkActions.size > 1;
  const bulkWorkUnits = bulkItems.reduce((total, item) => total + item.quantity, 0);
  const bulkCamCount = bulkAction === "complete"
    ? bulkItems.filter(({ operation }) => operation.workType === "CAM").length
    : 0;
  const bulkButtonLabel = hasMixedBulkActions
    ? "Mixed selection"
    : bulkAction === "claim" || (!bulkAction && view === "available")
      ? "Bulk claim"
      : bulkAction === "complete" || (!bulkAction && view === "mine")
        ? "Mark complete"
        : "Bulk action";

  useEffect(() => {
    const api = operationsGridRef.current?.api;
    if (!api) return;

    const selectedIds = new Set(bulkSelectedIds);
    const toSelect: Parameters<typeof api.setNodesSelected>[0]["nodes"] = [];
    const toDeselect: Parameters<typeof api.setNodesSelected>[0]["nodes"] = [];
    api.forEachNode((node) => {
      if (!node.data) return;
      (selectedIds.has(node.data.id) ? toSelect : toDeselect).push(node);
    });
    if (toSelect.length > 0) api.setNodesSelected({ nodes: toSelect, newValue: true, source: "api" });
    if (toDeselect.length > 0) api.setNodesSelected({ nodes: toDeselect, newValue: false, source: "api" });
  }, [bulkSelectedIds, filtered]);

  const stats = useMemo(() => ({
    ready: operations.filter((operation) => ["Ready", "In Progress", "Needs Rework"].includes(operation.status) && operation.availableQuantity > 0).length,
    active: operations.filter((operation) => operation.status === "In Progress").length,
    attention: operations.filter((operation) => operation.status === "Blocked" || operation.status === "Needs Rework").length,
    complete: operations.filter((operation) => operation.status === "Complete").length,
  }), [operations]);

  const openOperation = (operation: ManufacturingOperation) => setSelectedId(operation.id);
  const runQuantityAction = (action: OperationQuantityAction, quantity: number) => {
    if (!selected) return;
    mutation.mutate({ id: selected.id, patch: { action, quantity }, workType: selected.workType });
  };
  const requestQuantityAction = (action: OperationQuantityAction, max: number) => {
    if (!isShopName(userName)) {
      openProfile();
      toast.info("Set your first name and last initial before recording work");
      return;
    }
    if (selected?.workType === "CAM" && action === "complete") {
      setCamProgramPath(selected.camProgramPath ?? "");
      setCamNotes(selected.camNotes);
      setCamCompletionOpen(true);
      return;
    }
    if (max <= 1) return runQuantityAction(action, 1);
    setQuantityDraft(String(max));
    setQuantityDialog({ action, max });
  };
  const completeCam = () => {
    if (!selected || selected.workType !== "CAM") return;
    mutation.mutate({
      id: selected.id,
      patch: {
        action: "complete",
        quantity: 1,
        ...(camProgramPath.trim() ? { programPath: camProgramPath.trim() } : {}),
        notes: camNotes.trim(),
      },
      workType: "CAM",
    });
  };
  const openCamHandoffEditor = () => {
    if (!selectedCamHandoff || selectedCamHandoff.status !== "Complete") return;
    setCamCompletedBy(selectedCamHandoff.completedBy);
    setCamProgramPath(selectedCamHandoff.programPath ?? "");
    setCamNotes(selectedCamHandoff.notes);
    setCamHandoffEditOpen(true);
  };
  const saveCamHandoff = () => {
    if (!selectedCamHandoff) return;
    camHandoffMutation.mutate({
      id: selectedCamHandoff.operationId,
      patch: {
        action: "edit_cam_handoff",
        completedBy: camCompletedBy.trim(),
        programPath: camProgramPath.trim(),
        notes: camNotes.trim(),
      },
    });
  };
  const copyProgramPath = async (programPath: string) => {
    try {
      await navigator.clipboard.writeText(programPath);
      toast.success("Program path copied");
    } catch {
      toast.error("Unable to copy the program path");
    }
  };
  const requestSteal = () => {
    if (!isShopName(userName)) {
      openProfile();
      toast.info("Set your first name and last initial before recording work");
      return;
    }
    setStealDialogOpen(true);
  };
  const requestBulkAction = () => {
    if (bulkItems.length === 0 || !bulkAction) return;
    if (!isShopName(userName)) {
      openProfile();
      toast.info("Set your first name and last initial before recording work");
      return;
    }
    setBulkCamProgramPath("");
    setBulkCamNotes("");
    setBulkActionDialogOpen(true);
  };
  const changeQueueView = (nextView: QueueView) => {
    setView(nextView);
  };
  const openProfile = () => {
    const match = userName.match(/^(.+?)\s+([\p{L}])\.$/u);
    setFirstName(match?.[1] ?? userName.split(/\s+/)[0] ?? "");
    setLastInitial(match?.[2] ?? "");
    setProfileOpen(true);
  };

  const columnDefs = useMemo<ColDef<ManufacturingOperation>[]>(() => [
    { field: "partNumber", headerName: "PART", minWidth: 155, pinned: "left", cellClass: "font-mono font-semibold" },
    { field: "revision", headerName: "REVISION", width: 104, valueFormatter: ({ value }) => value || "—" },
    { field: "partName", headerName: "DESCRIPTION", minWidth: 230, flex: 1 },
    { field: "material", headerName: "MATERIAL", minWidth: 165, valueFormatter: ({ value }) => value || "Unspecified" },
    { field: "documentName", headerName: "SOURCE DOCUMENT", minWidth: 175, valueFormatter: ({ value }) => value || "Not synced" },
    { field: "taskQuantity", headerName: "REQUIRED", width: 98, filter: "agNumberColumnFilter" },
    { field: "availableQuantity", headerName: "AVAILABLE", width: 98, filter: "agNumberColumnFilter" },
    { field: "completedQuantity", headerName: "DONE", width: 82, filter: "agNumberColumnFilter" },
    { field: "operationNumber", headerName: "OP", width: 125, filter: true, valueFormatter: ({ data, value }) => data ? operationLabel(data) : value },
    { field: "workType", headerName: "TYPE", width: 128, filter: true },
    { field: "machine", headerName: "MACHINE", minWidth: 175, filter: true },
    { field: "status", headerName: "STATUS", minWidth: 145, cellRenderer: StatusCell },
    { field: "machinist", headerName: "MACHINIST", minWidth: 180, valueFormatter: ({ value }) => value || "—" },
    { headerName: "", width: 102, pinned: "right", sortable: false, filter: false, resizable: false, cellRenderer: ActionCell, cellRendererParams: { onOpen: openOperation, user: query.data?.user ?? null } },
  ], [query.data?.user]);

  const rowSelection = useMemo(() => ({
    mode: "multiRow" as const,
    checkboxes: true,
    headerCheckbox: true,
    selectAll: "all" as const,
    hideDisabledCheckboxes: false,
    enableClickSelection: false,
    isRowSelectable: ({ data }: { data?: ManufacturingOperation }) => Boolean(
      data && bulkActionPlan(data, query.data?.user ?? null, view),
    ),
  }), [query.data?.user, view]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <NotificationInbox userId={query.data?.user?.approved && query.data.user.id !== "demo-admin" ? query.data.user.id : null} />
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1800px] items-center gap-5 px-4 md:px-7">
          <div className="flex items-center gap-3 md:min-w-56">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm"><Factory className="size-5" /></div>
            <div><p className="text-sm font-bold leading-none">FRC 190</p><p className="mt-1 text-[10px] font-semibold uppercase tracking-[.17em] text-muted-foreground">Manufacturing OS</p></div>
          </div>
          <nav className="hidden h-full items-center gap-1 md:flex">
            <Button
              variant="ghost"
              className={cn("h-10", workspaceView === "operations" ? "bg-accent/70 text-primary" : "text-muted-foreground")}
              aria-current={workspaceView === "operations" ? "page" : undefined}
              nativeButton={false}
              render={<Link href={WORKSPACE_ROUTES.operations} />}
            >
              <LayoutList /><span className="hidden lg:inline">Operations</span>
            </Button>
            <Button
              variant="ghost"
              className={cn("h-10", workspaceView === "fabrication" ? "bg-accent/70 text-primary" : "text-muted-foreground")}
              aria-current={workspaceView === "fabrication" ? "page" : undefined}
              aria-label="Finishing"
              nativeButton={false}
              render={<Link href={WORKSPACE_ROUTES.fabrication} />}
            >
              <Paintbrush /><span className="hidden lg:inline">Finishing</span>
            </Button>
            <Button
              variant="ghost"
              className={cn("h-10", workspaceView === "production" ? "bg-accent/70 text-primary" : "text-muted-foreground")}
              aria-current={workspaceView === "production" ? "page" : undefined}
              nativeButton={false}
              render={<Link href={WORKSPACE_ROUTES.production} />}
            >
              <PackageCheck /><span className="hidden lg:inline">Production</span>
            </Button>
            {query.data?.user?.role === "admin" && (
              <Button
                variant="ghost"
                className={cn("h-10", workspaceView === "admin" ? "bg-accent/70 text-primary" : "text-muted-foreground")}
                aria-current={workspaceView === "admin" ? "page" : undefined}
                nativeButton={false}
                render={<Link href={WORKSPACE_ROUTES.admin} />}
              >
                <ShieldCheck /><span className="hidden lg:inline">Admin</span>
              </Button>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 sm:flex">
              <Cloud className="size-3.5" />
              Supabase live
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh data"
              onClick={() => workspaceView === "fabrication" ? queryClient.invalidateQueries({ queryKey: ["fabrication"] }) : query.refetch()}
              disabled={workspaceView !== "fabrication" && query.isFetching}
            ><RefreshCw className={cn(workspaceView !== "fabrication" && query.isFetching && "animate-spin")} /></Button>
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
                <DropdownMenuItem onClick={openProfile}>Edit shop name</DropdownMenuItem>
                <DropdownMenuItem render={<a href="/login" />}>Switch account</DropdownMenuItem>
                <DropdownMenuItem render={<a href="/auth/signout" />}>Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <nav className={cn("grid gap-1 border-t px-3 py-1.5 md:hidden", query.data?.user?.role === "admin" ? "grid-cols-4" : "grid-cols-3")}>
          {[
            { id: "operations" as const, label: "Operations", icon: LayoutList },
            { id: "fabrication" as const, label: "Finishing", icon: Paintbrush },
            { id: "production" as const, label: "Production", icon: PackageCheck },
            ...(query.data?.user?.role === "admin" ? [{ id: "admin" as const, label: "Admin", icon: ShieldCheck }] : []),
          ].map(({ id, label, icon: Icon }) => (
            <Button key={id} size="sm" variant="ghost" className={cn("min-w-0 gap-1 px-1 text-[11px]", workspaceView === id ? "bg-accent/70 text-primary" : "text-muted-foreground")} aria-current={workspaceView === id ? "page" : undefined} nativeButton={false} render={<Link href={WORKSPACE_ROUTES[id]} />}><Icon />{label}</Button>
          ))}
        </nav>
      </header>

      {workspaceView === "admin" ? <AdminDashboard /> : workspaceView === "operations" ? <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
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
                  <Button key={item.id} size="sm" variant="ghost" onClick={() => changeQueueView(item.id)} className={cn("min-w-fit", view === item.id && "bg-card text-foreground shadow-sm hover:bg-card")}>
                    {item.label}{item.id === "available" && <span className="ml-1 rounded bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-800">{stats.ready}</span>}
                  </Button>
                ))}
              </div>
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, revision, assembly, operation…" />
              </div>
              <Select value={workType} onValueChange={(value) => setWorkType((value ?? "all") as WorkTypeFilter)}>
                <SelectTrigger className="h-9 w-full bg-card xl:w-48"><Code2 className="text-muted-foreground" /><SelectValue placeholder="All work types" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All work types</SelectItem><SelectItem value="Manufacturing">Manufacturing</SelectItem><SelectItem value="CAM">CAM</SelectItem></SelectContent>
              </Select>
              <Select value={machine} onValueChange={(value) => setMachine(value ?? "all")}>
                <SelectTrigger className="h-9 w-full bg-card xl:w-56"><Wrench className="text-muted-foreground" /><SelectValue placeholder="All machines" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All machines</SelectItem>{machines.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={sourceDocument} onValueChange={(value) => setSourceDocument(value ?? "all")}>
                <SelectTrigger className="h-9 w-full bg-card xl:w-56"><FileText className="text-muted-foreground" /><SelectValue placeholder="All source documents" /></SelectTrigger>
                <SelectContent><SelectItem value="all">All source documents</SelectItem>{sourceDocuments.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}<SelectItem value="missing">Not synced</SelectItem></SelectContent>
              </Select>
              <div className="flex items-center justify-between gap-3 xl:justify-end">
                <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground"><SlidersHorizontal className="size-3.5" /> {filtered.length} shown</div>
                <Button size="sm" onClick={requestBulkAction} disabled={bulkItems.length === 0 || !bulkAction || bulkActionMutation.isPending} title={hasMixedBulkActions ? "Select only claimable work or only work assigned to you" : undefined}>
                  {bulkActionMutation.isPending ? <LoaderCircle className="animate-spin" /> : <ListChecks />} {bulkButtonLabel}{bulkItems.length > 0 ? ` (${bulkItems.length})` : ""}
                </Button>
              </div>
            </div>
          </div>

          {query.isLoading ? (
            <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>
          ) : query.isError ? (
            <div className="grid min-h-80 place-items-center p-6 text-center"><div><XCircle className="mx-auto mb-3 size-9 text-destructive" /><h2 className="font-semibold">Couldn’t load the queue</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
          ) : filtered.length === 0 ? (
            <div className="grid min-h-80 place-items-center p-6 text-center"><div><PackageCheck className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No operations match</h2><p className="mt-1 text-sm text-muted-foreground">Try another work type, machine, or source document, or clear the search.</p><Button variant="outline" className="mt-4" onClick={() => { setWorkType("all"); setMachine("all"); setSourceDocument("all"); setSearch(""); setView("all"); }}>Clear filters</Button></div></div>
          ) : (
            <>
              <div className="hidden h-[min(59vh,680px)] min-h-[430px] md:block">
                <AgGridReact<ManufacturingOperation>
                  ref={operationsGridRef}
                  theme={gridTheme}
                  rowData={filtered}
                  columnDefs={columnDefs}
                  rowSelection={rowSelection}
                  selectionColumnDef={{ width: 48, pinned: "left", resizable: false }}
                  onSelectionChanged={({ api, source }) => {
                    if (["api", "rowDataChanged", "gridInitializing", "selectableChanged"].includes(source)) return;
                    const selectedVisibleIds = api.getSelectedRows().map((operation) => operation.id);
                    setBulkSelectedIds((current) => mergeVisibleSelection(
                      current,
                      filtered.map((operation) => operation.id),
                      selectedVisibleIds,
                    ));
                  }}
                  defaultColDef={{ sortable: true, filter: false, resizable: true }}
                  getRowId={({ data }) => String(data.id)}
                  onRowDoubleClicked={({ data }) => data && openOperation(data)}
                  pagination
                  paginationPageSize={25}
                  paginationPageSizeSelector={[10, 25, 50]}
                  stopEditingWhenCellsLoseFocus
                  animateRows
                />
              </div>
              <div className="divide-y md:hidden">
                {filtered.map((operation) => {
                  const plan = bulkActionPlan(operation, query.data?.user ?? null, view);
                  const checked = bulkSelectedIds.includes(operation.id);
                  return (
                    <article key={operation.id} className="flex items-start gap-3 p-4 transition hover:bg-muted/40">
                      <Checkbox
                        className="mt-1"
                        checked={checked}
                        disabled={!plan}
                        aria-label={`Select ${operation.partNumber} ${operationLabel(operation)} to ${plan?.action === "claim" ? "claim" : "mark complete"}`}
                        onCheckedChange={(nextChecked) => setBulkSelectedIds((current) => nextChecked ? [...new Set([...current, operation.id])] : current.filter((id) => id !== operation.id))}
                      />
                      <button onClick={() => openOperation(operation)} className="min-w-0 flex-1 text-left">
                        <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-primary">{operation.partNumber}</p><h3 className="mt-1 font-semibold">{operation.partName}</h3></div><StatusBadge status={operation.status} /></div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"><span>Rev {operation.revision ?? "—"}</span><span>{operationLabel(operation)}</span><Badge variant="outline">{operation.workType}</Badge><span className="flex items-center gap-1"><Wrench className="size-3" />{operation.machine}</span><span>{operation.completedQuantity}/{operation.taskQuantity} done</span><span>{operation.availableQuantity} available</span></div>
                      </button>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-1 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Open a manufacturing or CAM operation to claim, release, complete, or undo work.</span>
          <span>Last refreshed {query.data ? formatDate(query.data.syncedAt) : "—"}</span>
        </div>
      </section> : workspaceView === "fabrication" ? (
        <FabricationDashboard user={query.data?.user ?? null} onProfileRequired={openProfile} />
      ) : (
        <ProductionOverview
          operations={operations}
          isLoading={query.isLoading}
          isError={query.isError}
          errorMessage={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      )}

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader className="border-b p-6 pr-14">
                <div className="mb-2 flex items-center gap-2"><StatusBadge status={selected.status} /><Badge variant="outline">{operationLabel(selected)}</Badge><Badge variant="outline">{selected.workType}</Badge></div>
                <SheetTitle className="text-2xl font-bold tracking-tight">{selected.workType === "CAM" ? `CAM — ${selected.partName}` : selected.partName}</SheetTitle>
                <SheetDescription className="font-mono text-xs font-semibold text-primary">{selected.partNumber}</SheetDescription>
              </SheetHeader>

              <div className="space-y-6 p-6">
                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Operation details</h3>
                  <div className="grid grid-cols-2 overflow-hidden rounded-xl border">
                    {[
                      [selected.workType === "CAM" ? "Target machine" : "Machine", selected.machine], ["Work", operationLabel(selected)],
                      ["Revision", selected.revision || "—"], ["Assembly", selected.assemblyNumber],
                      ["Part quantity", String(selected.quantity)], ["Task quantity", String(selected.taskQuantity)],
                      ["Available", String(selected.availableQuantity)], ["Claimed", String(selected.claimedQuantity)],
                      ["Completed", String(selected.completedQuantity)], ["Your claim", String(selectedAllocation.claimed)],
                      ["Source document", selected.documentName || "Not synced"], ["Machinist", selected.machinist || "Unclaimed"],
                      ["Started", formatDate(selected.startedAt)], ["Finished", formatDate(selected.completedAt)],
                    ].map(([label, value], index, details) => <div key={label} className={cn("p-3", index % 2 === 0 && "border-r", index < details.length - 2 && "border-b")}><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}
                  </div>
                </section>

                {(selected.workType === "CAM" || selected.camDependency) && (
                  <section>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">CAM handoff</h3>
                      {query.data?.user?.role === "admin" && selectedCamHandoff?.status === "Complete" && (
                        <Button size="sm" variant="outline" onClick={openCamHandoffEditor}><Pencil /> Edit handoff</Button>
                      )}
                    </div>
                    <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                      {selected.workType === "Manufacturing" && selected.camDependency && (
                        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={selected.camDependency.status} /><span className="text-xs text-muted-foreground">CAM for {selected.operationNumber}</span></div>
                      )}
                      {selectedCamHandoff?.status === "Complete" && (
                        <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Completed by</p><p className="mt-1 text-sm font-semibold">{selectedCamHandoff.completedBy || "Not recorded"}</p></div>
                      )}
                      {(selected.workType === "CAM" ? selected.camProgramPath : selected.camDependency?.programPath) ? (
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Shared-drive program path</p>
                          <div className="mt-1.5 flex items-start gap-2"><code className="min-w-0 flex-1 break-all rounded-lg bg-background p-2.5 text-xs">{selected.workType === "CAM" ? selected.camProgramPath : selected.camDependency?.programPath}</code><Button size="icon" variant="outline" aria-label="Copy program path" onClick={() => copyProgramPath((selected.workType === "CAM" ? selected.camProgramPath : selected.camDependency?.programPath) ?? "")}><ClipboardCopy /></Button></div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No program path has been recorded yet.</p>
                      )}
                      {(selected.workType === "CAM" ? selected.camNotes : selected.camDependency?.notes) && (
                        <div><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Setup notes</p><p className="mt-1 whitespace-pre-wrap text-sm">{selected.workType === "CAM" ? selected.camNotes : selected.camDependency?.notes}</p></div>
                      )}
                    </div>
                  </section>
                )}

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
                      { label: "Drawing PDF", href: selected.hasDrawingPdf ? `/api/operations/${selected.id}/files/drawing-pdf` : null, fileName: selected.drawingPdfName, icon: FileText },
                      { label: "STEP file", href: selected.hasStepFile ? `/api/operations/${selected.id}/files/step` : null, fileName: selected.stepName, icon: Download },
                      { label: "Onshape drawing", href: selected.drawingUrl, fileName: null, icon: ArrowUpRight },
                      { label: "BOM source", href: selected.onshapeUrl, fileName: null, icon: Cloud },
                    ].map(({ label, href, fileName, icon: Icon }) => href ? (
                      <a key={label} href={href} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-xl border p-3 text-sm font-semibold transition hover:border-primary/40 hover:bg-accent/40"><div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></div><span className="min-w-0"><span className="block">{label}</span>{fileName && <span className="block truncate text-[10px] font-normal text-muted-foreground">{fileName}</span>}</span><ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" /></a>
                    ) : (
                      <div key={label} className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm text-muted-foreground"><div className="grid size-8 place-items-center rounded-lg bg-muted"><Icon className="size-4" /></div>{label}<span className="ml-auto text-[10px] uppercase">Missing</span></div>
                    ))}
                  </div>
                </section>
              </div>

              <SheetFooter className="sticky bottom-0 border-t bg-card/95 p-4 backdrop-blur">
                {["Ready", "In Progress", "Needs Rework"].includes(selected.status) && selected.availableQuantity > 0 && <Button size="lg" className="h-11" onClick={() => requestQuantityAction("claim", selected.availableQuantity)} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <CircleDot />} {selected.workType === "CAM" ? "Claim CAM task" : `Claim ${selected.availableQuantity === 1 ? "part" : "parts"}`}</Button>}
                {isOperationStealable(selected, query.data?.user ?? null) && <Button size="lg" variant="destructive" className="h-11" onClick={requestSteal} disabled={mutation.isPending}><TriangleAlert /> Steal {selected.workType === "CAM" ? "CAM task" : "production requirement"}</Button>}
                {selectedAllocation.claimed > 0 && <Button size="lg" className="h-11 bg-emerald-600 hover:bg-emerald-700" onClick={() => requestQuantityAction("complete", selectedAllocation.claimed)} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Check />} Mark complete</Button>}
                {selectedAllocation.claimed > 0 && <Button variant="outline" onClick={() => requestQuantityAction("release", selectedAllocation.claimed)} disabled={mutation.isPending}><RotateCcw /> Release claim</Button>}
                {selectedAllocation.completed > 0 && <Button variant="outline" onClick={() => requestQuantityAction("undo_complete", selectedAllocation.completed)} disabled={mutation.isPending}><RotateCcw /> Undo completion</Button>}
                {selected.status === "Complete" && <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"><Check className="size-4" /> {selected.workType === "CAM" ? "CAM completed" : `${selected.completedQuantity} of ${selected.taskQuantity} completed`} by {selected.machinist || "machinist"}</div>}
                <Button variant="outline" onClick={() => setSelectedId(null)}>Close</Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(quantityDialog)} onOpenChange={(open) => !open && setQuantityDialog(null)}>
        <DialogContent>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!quantityDialog) return;
            const quantity = Number(quantityDraft);
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > quantityDialog.max) {
              toast.error(`Enter a whole number from 1 to ${quantityDialog.max}`);
              return;
            }
            runQuantityAction(quantityDialog.action, quantity);
          }}>
            <DialogHeader>
              <DialogTitle>{quantityDialog ? quantityActionCopy[quantityDialog.action].title : "Update quantity"}</DialogTitle>
              <DialogDescription>Choose a whole number from 1 to {quantityDialog?.max ?? 1}. You can reverse this action afterward.</DialogDescription>
            </DialogHeader>
            <div className="my-5"><label className="mb-1.5 block text-xs font-semibold" htmlFor="action-quantity">Number of parts</label><Input id="action-quantity" type="number" inputMode="numeric" min={1} max={quantityDialog?.max ?? 1} step={1} value={quantityDraft} onChange={(event) => setQuantityDraft(event.target.value)} autoFocus /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setQuantityDialog(null)}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending && <LoaderCircle className="animate-spin" />}{quantityDialog ? quantityActionCopy[quantityDialog.action].button : "Save"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={camCompletionOpen} onOpenChange={setCamCompletionOpen}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); completeCam(); }}>
            <DialogHeader>
              <DialogTitle>Complete {selected ? operationLabel(selected) : "CAM"}</DialogTitle>
              <DialogDescription>Optionally record the shared-drive program location so the machine operator can retrieve the approved CAM output.</DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold" htmlFor="cam-program-path">Shared-drive program path <span className="font-normal text-muted-foreground">(optional)</span></label>
                <Input id="cam-program-path" value={camProgramPath} onChange={(event) => setCamProgramPath(event.target.value)} placeholder="\\\\server\\manufacturing\\program.nc" maxLength={1024} autoFocus />
                <p className="mt-1.5 text-xs text-muted-foreground">UNC and mapped-drive paths are accepted. The app stores and copies the path without trying to open it.</p>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold" htmlFor="cam-notes">Setup notes <span className="font-normal text-muted-foreground">(optional)</span></label>
                <textarea id="cam-notes" value={camNotes} onChange={(event) => setCamNotes(event.target.value)} maxLength={5000} placeholder="Workholding, tooling, or setup detail. Include here if your CAM has been checked." className="min-h-28 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50" />
              </div>
            </div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setCamCompletionOpen(false)}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending && <LoaderCircle className="animate-spin" />}Complete CAM</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={camHandoffEditOpen} onOpenChange={setCamHandoffEditOpen}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); saveCamHandoff(); }}>
            <DialogHeader>
              <DialogTitle>Edit CAM handoff</DialogTitle>
              <DialogDescription>Administrators can correct the CAM attribution and the details handed to the machine operator.</DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold" htmlFor="cam-completed-by">Completed by</label>
                <Input id="cam-completed-by" value={camCompletedBy} onChange={(event) => setCamCompletedBy(event.target.value)} maxLength={120} required autoFocus />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold" htmlFor="cam-edit-program-path">Shared-drive program path <span className="font-normal text-muted-foreground">(optional)</span></label>
                <Input id="cam-edit-program-path" value={camProgramPath} onChange={(event) => setCamProgramPath(event.target.value)} placeholder="\\\\server\\manufacturing\\program.nc" maxLength={1024} />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold" htmlFor="cam-edit-notes">Setup notes <span className="font-normal text-muted-foreground">(optional)</span></label>
                <textarea id="cam-edit-notes" value={camNotes} onChange={(event) => setCamNotes(event.target.value)} maxLength={5000} className="min-h-28 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50" />
              </div>
            </div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setCamHandoffEditOpen(false)}>Cancel</Button><Button type="submit" disabled={camHandoffMutation.isPending || !camCompletedBy.trim()}>{camHandoffMutation.isPending && <LoaderCircle className="animate-spin" />}Save handoff</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={stealDialogOpen} onOpenChange={setStealDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-1 grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive"><TriangleAlert className="size-5" /></div>
            <DialogTitle>Steal this {selected?.workType === "CAM" ? "CAM task" : "production requirement"}?</DialogTitle>
            <DialogDescription>
              This immediately transfers the claimed work from {selectedOtherClaimants.map((claimant) => claimant.name).join(", ") || "the current claimant"} to you. They will receive a website alert and an email. Completed work will not change.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm">
            <p className="font-semibold">This action cannot be undone automatically.</p>
            <p className="mt-1 text-muted-foreground">Confirm only if you have coordinated the handoff or the work needs to be reassigned now.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStealDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => selected && mutation.mutate({ id: selected.id, patch: { action: "steal", confirmed: true } })}
              disabled={!selected || mutation.isPending}
            >
              {mutation.isPending && <LoaderCircle className="animate-spin" />} Yes, steal requirement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkActionDialogOpen} onOpenChange={setBulkActionDialogOpen}>
        <DialogContent>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!bulkAction) return;
            bulkActionMutation.mutate({
              action: bulkAction,
              items: bulkItems.map(({ operation, quantity }) => ({
                id: operation.id,
                quantity,
                workType: operation.workType,
              })),
              programPath: bulkCamProgramPath.trim(),
              notes: bulkCamNotes.trim(),
            });
          }}>
            <DialogHeader>
              <div className="mb-1 grid size-10 place-items-center rounded-full bg-primary/10 text-primary"><ListChecks className="size-5" /></div>
              <DialogTitle>{bulkAction === "claim" ? "Claim" : "Complete"} {bulkItems.length} operations?</DialogTitle>
              <DialogDescription>{bulkAction === "claim"
                ? "This claims every currently available work unit on the selected operations."
                : "This marks all work you currently have claimed on the selected operations as complete."}</DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div className="rounded-xl border bg-muted/30 p-3 text-sm">
                <p className="font-semibold">{bulkWorkUnits} {bulkWorkUnits === 1 ? "work unit" : "work units"} total</p>
                <p className="mt-1 text-muted-foreground">Across {bulkItems.length} selected {bulkItems.length === 1 ? "operation" : "operations"}.</p>
              </div>
              {bulkCamCount > 0 && (
                <div className="space-y-4 rounded-xl border p-4">
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold" htmlFor="bulk-cam-program-path">Shared-drive program path <span className="font-normal text-muted-foreground">(optional)</span></label>
                    <Input id="bulk-cam-program-path" value={bulkCamProgramPath} onChange={(event) => setBulkCamProgramPath(event.target.value)} placeholder="\\\\server\\manufacturing\\program.nc" maxLength={1024} autoFocus />
                    <p className="mt-1.5 text-xs text-muted-foreground">If provided, applied to all {bulkCamCount} selected CAM {bulkCamCount === 1 ? "task" : "tasks"}.</p>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold" htmlFor="bulk-cam-notes">Setup notes <span className="font-normal text-muted-foreground">(optional)</span></label>
                    <textarea id="bulk-cam-notes" value={bulkCamNotes} onChange={(event) => setBulkCamNotes(event.target.value)} maxLength={5000} placeholder="Workholding, tooling, post-processor, or setup details…" className="min-h-24 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50" />
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBulkActionDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={bulkItems.length === 0 || !bulkAction || bulkActionMutation.isPending}>
                {bulkActionMutation.isPending && <LoaderCircle className="animate-spin" />} {bulkAction === "claim" ? "Claim selected" : "Mark selected complete"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); profileMutation.mutate(); }}>
            <DialogHeader>
              <DialogTitle>Edit shop name</DialogTitle>
              <DialogDescription>This name is recorded on claims and completed work instead of your email identifier.</DialogDescription>
            </DialogHeader>
            <div className="my-5 grid grid-cols-[minmax(0,1fr)_7rem] gap-3"><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="profile-first-name">First name</label><Input id="profile-first-name" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></div><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="profile-last-initial">Last initial</label><Input id="profile-last-initial" autoComplete="family-name" maxLength={1} value={lastInitial} onChange={(event) => setLastInitial(event.target.value)} required className="uppercase" /></div></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setProfileOpen(false)}>Cancel</Button><Button type="submit" disabled={profileMutation.isPending}>{profileMutation.isPending && <LoaderCircle className="animate-spin" />}Save shop name</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
