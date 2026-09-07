"use client";

import { themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Search, ShieldCheck, SlidersHorizontal, UserCheck, Users } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminResponse, AdminUserSummary, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

type ApprovalFilter = "all" | "pending" | "approved";

interface AdminUserGridRow extends AdminUserSummary {
  draftRole: UserRole;
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
  rowHeight: 72,
  headerHeight: 42,
  wrapperBorderRadius: 0,
  spacing: 6,
});

async function fetchAdmin(): Promise<AdminResponse> {
  const response = await fetch("/api/admin", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to load the admin workspace");
  return body;
}

async function updateUser(user: AdminUserSummary, role: UserRole, approved: boolean) {
  const response = await fetch(`/api/admin/users/${user.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, approved }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to update the account");
  return body;
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function AccountCell({ data }: { data?: AdminUserGridRow }) {
  if (!data) return null;
  return (
    <div className="flex h-full min-w-0 items-center gap-3">
      <div className={cn("grid size-9 shrink-0 place-items-center rounded-full", data.approved ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800")}>
        <UserCheck className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate font-semibold" title={data.name}>{data.name}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={data.email}>{data.email}</p>
      </div>
    </div>
  );
}

function ApprovalCell({ value }: { value: boolean }) {
  return (
    <div className="flex h-full items-center">
      <Badge variant="outline" className={value ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}>{value ? "Approved" : "Pending"}</Badge>
    </div>
  );
}

function DateCell({ value }: { value: string | null }) {
  return <div className="flex h-full items-center text-xs text-muted-foreground">{formatDate(value)}</div>;
}

function RoleCell({ data, onChange }: { data?: AdminUserGridRow; onChange: (id: string, role: UserRole) => void }) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center">
      <Select value={data.draftRole} onValueChange={(value) => onChange(data.id, (value ?? "machinist") as UserRole)}>
        <SelectTrigger className="h-9 w-full bg-background"><SelectValue>{data.draftRole === "admin" ? "Administrator" : "Machinist"}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="machinist">Machinist</SelectItem><SelectItem value="admin">Administrator</SelectItem></SelectContent>
      </Select>
    </div>
  );
}

function ActionCell({
  data,
  pending,
  onUpdate,
}: {
  data?: AdminUserGridRow;
  pending: boolean;
  onUpdate: (user: AdminUserSummary, role: UserRole, approved: boolean) => void;
}) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center justify-end gap-2">
      <Button size="sm" variant={data.approved ? "outline" : "default"} disabled={pending} onClick={() => onUpdate(data, data.draftRole, !data.approved)}>{data.approved ? "Revoke" : "Approve"}</Button>
      {data.approved && data.draftRole !== data.role && <Button size="sm" disabled={pending} onClick={() => onUpdate(data, data.draftRole, true)}>Save role</Button>}
    </div>
  );
}

export function AdminDashboard() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin"], queryFn: fetchAdmin });
  const [roleDrafts, setRoleDrafts] = useState<Record<string, UserRole>>({});
  const [search, setSearch] = useState("");
  const [approval, setApproval] = useState<ApprovalFilter>("all");
  const [roleFilter, setRoleFilter] = useState<"all" | UserRole>("all");

  const userMutation = useMutation({
    mutationFn: ({ user, role, approved }: { user: AdminUserSummary; role: UserRole; approved: boolean }) => updateUser(user, role, approved),
    onSuccess: () => {
      toast.success("Account access updated");
      queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update account"),
  });
  const mutateUser = userMutation.mutate;
  const mutationIsPending = userMutation.isPending;

  const users = useMemo<AdminUserGridRow[]>(() => (query.data?.users ?? []).map((user) => ({
    ...user,
    draftRole: roleDrafts[user.id] ?? user.role,
  })), [query.data?.users, roleDrafts]);

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return users.filter((user) => {
      if (approval === "pending" && user.approved) return false;
      if (approval === "approved" && !user.approved) return false;
      if (roleFilter !== "all" && user.role !== roleFilter) return false;
      if (term && ![user.name, user.email, user.role, user.approved ? "approved" : "pending"].join(" ").toLocaleLowerCase().includes(term)) return false;
      return true;
    });
  }, [approval, roleFilter, search, users]);

  const stats = useMemo(() => ({
    pendingUsers: users.filter((user) => !user.approved).length,
    approvedUsers: users.filter((user) => user.approved).length,
  }), [users]);

  const updateRoleDraft = useCallback((id: string, role: UserRole) => {
    setRoleDrafts((current) => ({ ...current, [id]: role }));
  }, []);
  const columnDefs = useMemo<ColDef<AdminUserGridRow>[]>(() => [
    {
      colId: "account",
      headerName: "ACCOUNT",
      minWidth: 260,
      flex: 1,
      pinned: "left",
      valueGetter: ({ data }) => data ? `${data.name} ${data.email}` : "",
      cellRenderer: AccountCell,
    },
    { field: "approved", headerName: "ACCESS", width: 130, cellRenderer: ApprovalCell },
    { field: "role", headerName: "CURRENT ROLE", width: 145, valueFormatter: ({ value }) => value === "admin" ? "Administrator" : "Machinist" },
    { field: "draftRole", headerName: "ASSIGN ROLE", width: 190, cellRenderer: RoleCell, cellRendererParams: { onChange: updateRoleDraft } },
    { field: "createdAt", headerName: "JOINED", minWidth: 165, cellRenderer: DateCell },
    { field: "lastSeenAt", headerName: "LAST OPENED", minWidth: 165, cellRenderer: DateCell, valueFormatter: ({ value }) => value || "Never" },
    {
      headerName: "ACTIONS",
      width: 220,
      pinned: "right",
      sortable: false,
      filter: false,
      resizable: false,
      cellRenderer: ActionCell,
      cellRendererParams: {
        pending: mutationIsPending,
        onUpdate: (user: AdminUserSummary, role: UserRole, approved: boolean) => mutateUser({ user, role, approved }),
      },
    },
  ], [mutateUser, mutationIsPending, updateRoleDraft]);

  const clearFilters = () => {
    setSearch("");
    setApproval("all");
    setRoleFilter("all");
  };

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,.12)]" /> Administrator workspace</div>
          <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Access control</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Approve new team members and assign their shop role.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "Pending users", value: stats.pendingUsers, icon: Clock3, tone: "bg-amber-50 text-amber-800" },
            { label: "Approved", value: stats.approvedUsers, icon: Users, tone: "bg-blue-50 text-blue-700" },
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
            <div className="min-w-48 xl:mr-auto">
              <h2 className="font-semibold">User approvals</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Every new account starts pending with the machinist role.</p>
            </div>
            <div className="relative min-w-0 flex-1 xl:max-w-md">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search name, email, role, access…" />
            </div>
            <Select value={approval} onValueChange={(value) => setApproval((value ?? "all") as ApprovalFilter)}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-44"><SlidersHorizontal className="text-muted-foreground" /><SelectValue placeholder="All access" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All access</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="approved">Approved</SelectItem></SelectContent>
            </Select>
            <Select value={roleFilter} onValueChange={(value) => setRoleFilter((value ?? "all") as "all" | UserRole)}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-44"><ShieldCheck className="text-muted-foreground" /><SelectValue placeholder="All roles" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All roles</SelectItem><SelectItem value="machinist">Machinist</SelectItem><SelectItem value="admin">Administrator</SelectItem></SelectContent>
            </Select>
            <div className="whitespace-nowrap text-xs text-muted-foreground">{filteredUsers.length} of {users.length} shown</div>
          </div>
        </div>

        {query.isLoading ? (
          <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div>
        ) : query.isError ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><ShieldCheck className="mx-auto mb-3 size-10 text-destructive" /><h2 className="font-semibold">Couldn’t load the admin workspace</h2><p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
        ) : users.length === 0 ? (
          <div className="grid min-h-60 place-items-center p-6 text-center"><div><Users className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h3 className="font-semibold">No users to manage</h3><p className="mt-1 text-sm text-muted-foreground">Registered accounts will appear here.</p></div></div>
        ) : filteredUsers.length === 0 ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><Search className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No users match</h2><p className="mt-1 text-sm text-muted-foreground">Try another access status or role, or clear the search.</p><Button variant="outline" className="mt-4" onClick={clearFilters}>Clear filters</Button></div></div>
        ) : (
          <>
            <div className="hidden h-[min(59vh,680px)] min-h-[430px] md:block">
              <AgGridReact<AdminUserGridRow>
                theme={gridTheme}
                rowData={filteredUsers}
                columnDefs={columnDefs}
                defaultColDef={{ sortable: true, filter: true, resizable: true }}
                initialState={{ sort: { sortModel: [{ colId: "approved", sort: "asc" }, { colId: "account", sort: "asc" }] } }}
                getRowId={({ data }) => data.id}
                pagination
                paginationPageSize={25}
                paginationPageSizeSelector={[10, 25, 50]}
                animateRows
              />
            </div>
            <div className="divide-y md:hidden">
              {filteredUsers.map((user) => (
                <article key={user.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate font-semibold">{user.name}</h3><Badge variant="outline" className={user.approved ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}>{user.approved ? "Approved" : "Pending"}</Badge></div><p className="mt-1 truncate text-xs text-muted-foreground">{user.email}</p><p className="mt-1 text-[11px] text-muted-foreground">Joined {formatDate(user.createdAt)} · Last opened {formatDate(user.lastSeenAt)}</p></div>
                    <UserCheck className={cn("mt-1 size-5 shrink-0", user.approved ? "text-emerald-600" : "text-muted-foreground")} />
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Select value={user.draftRole} onValueChange={(value) => updateRoleDraft(user.id, (value ?? "machinist") as UserRole)}><SelectTrigger className="h-9 min-w-0 flex-1"><SelectValue>{user.draftRole === "admin" ? "Administrator" : "Machinist"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="machinist">Machinist</SelectItem><SelectItem value="admin">Administrator</SelectItem></SelectContent></Select>
                    <Button variant={user.approved ? "outline" : "default"} className="h-9" disabled={mutationIsPending} onClick={() => mutateUser({ user, role: user.draftRole, approved: !user.approved })}>{user.approved ? "Revoke" : "Approve"}</Button>
                    {user.approved && user.draftRole !== user.role && <Button className="h-9" disabled={mutationIsPending} onClick={() => mutateUser({ user, role: user.draftRole, approved: true })}>Save role</Button>}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
