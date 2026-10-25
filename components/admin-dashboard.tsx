"use client";

import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Search, ShieldCheck, SlidersHorizontal, UserCheck, Users } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { toast } from "sonner";

import { EngineeringCorrectionsReport } from "@/components/engineering-corrections-report";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FILTERABLE_COL_DEF, workspaceGridTheme } from "@/components/workspace-grid";
import { EmptyState, StatTiles } from "@/components/workspace-ui";
import { formatShortDateTime } from "@/lib/date-format";
import { requestJson } from "@/lib/request-json";
import type { AdminResponse, AdminUserSummary, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

type ApprovalFilter = "all" | "pending" | "approved";

interface AdminUserGridRow extends AdminUserSummary {
  draftRole: UserRole;
}

const gridTheme = workspaceGridTheme(72);
// Action cells read the pending state from context: putting it in cellRendererParams would rebuild
// columnDefs on every access change, and new columnDefs reset the user's column widths.
const UserUpdatePending = createContext(false);

function fetchAdmin() {
  return requestJson<AdminResponse>("/api/admin", { cache: "no-store" }, "Unable to load the admin workspace");
}

function updateUser(user: AdminUserSummary, role: UserRole, approved: boolean) {
  return requestJson(`/api/admin/users/${user.id}`, {
    method: "PATCH", body: JSON.stringify({ role, approved }),
  }, "Unable to update the account");
}

function AccountCell({ data }: { data?: AdminUserGridRow }) {
  if (!data) return null;
  return (
    <div className="flex h-full min-w-0 items-center gap-3 leading-normal">
      <div className={cn("grid size-9 shrink-0 place-items-center rounded-full", data.approved ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300" : "bg-amber-50 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300")}>
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
      <Badge variant="outline" className={value ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200" : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200"}>{value ? "Approved" : "Pending"}</Badge>
    </div>
  );
}

function DateCell({ value }: { value: string | null }) {
  return <div className="flex h-full items-center text-xs text-muted-foreground">{formatShortDateTime(value, "Never")}</div>;
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
  onUpdate,
}: {
  data?: AdminUserGridRow;
  onUpdate: (user: AdminUserSummary, role: UserRole, approved: boolean) => void;
}) {
  const pending = useContext(UserUpdatePending);
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
        onUpdate: (user: AdminUserSummary, role: UserRole, approved: boolean) => mutateUser({ user, role, approved }),
      },
    },
  ], [mutateUser, updateRoleDraft]);

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
        <StatTiles className="grid grid-cols-2 gap-2" items={[
          { label: "Pending users", value: stats.pendingUsers, icon: Clock3, tone: "bg-amber-50 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300" },
          { label: "Approved", value: stats.approvedUsers, icon: Users, tone: "bg-blue-50 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300" },
        ]} />
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
              <SelectTrigger className="h-9 w-full bg-card xl:w-44"><SlidersHorizontal className="text-muted-foreground" /><SelectValue>{approval === "all" ? "All access" : approval === "approved" ? "Approved" : "Pending"}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="all">All access</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="approved">Approved</SelectItem></SelectContent>
            </Select>
            <Select value={roleFilter} onValueChange={(value) => setRoleFilter((value ?? "all") as "all" | UserRole)}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-44"><ShieldCheck className="text-muted-foreground" /><SelectValue>{roleFilter === "all" ? "All roles" : roleFilter === "admin" ? "Administrator" : "Machinist"}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="all">All roles</SelectItem><SelectItem value="machinist">Machinist</SelectItem><SelectItem value="admin">Administrator</SelectItem></SelectContent>
            </Select>
            <div className="whitespace-nowrap text-xs text-muted-foreground">{filteredUsers.length} of {users.length} shown</div>
          </div>
        </div>

        {query.isPending ? (
          <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div>
        ) : query.isError && !query.data ? (
          <EmptyState icon={ShieldCheck} iconClassName="size-10 text-destructive" title="Couldn’t load the admin workspace" message={query.error.message}><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></EmptyState>
        ) : users.length === 0 ? (
          <EmptyState className="min-h-60" icon={Users} iconClassName="size-10 text-muted-foreground/60" titleAs="h3" title="No users to manage" message="Registered accounts will appear here." />
        ) : filteredUsers.length === 0 ? (
          <EmptyState icon={Search} iconClassName="size-10 text-muted-foreground/60" title="No users match" message="Try another access status or role, or clear the search."><Button variant="outline" className="mt-4" onClick={clearFilters}>Clear filters</Button></EmptyState>
        ) : (
          <>
            <div className="hidden h-[min(59vh,680px)] min-h-[430px] md:block">
              <UserUpdatePending value={mutationIsPending}>
                <AgGridReact<AdminUserGridRow>
                  theme={gridTheme}
                  rowData={filteredUsers}
                  columnDefs={columnDefs}
                  defaultColDef={FILTERABLE_COL_DEF}
                  getRowId={({ data }) => data.id}
                  pagination
                  paginationPageSize={25}
                  paginationPageSizeSelector={[10, 25, 50]}
                  animateRows
                />
              </UserUpdatePending>
            </div>
            <div className="divide-y md:hidden">
              {filteredUsers.map((user) => (
                <article key={user.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate font-semibold">{user.name}</h3><Badge variant="outline" className={user.approved ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200" : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200"}>{user.approved ? "Approved" : "Pending"}</Badge></div><p className="mt-1 truncate text-xs text-muted-foreground">{user.email}</p><p className="mt-1 text-[11px] text-muted-foreground">Joined {formatShortDateTime(user.createdAt, "Never")} · Last opened {formatShortDateTime(user.lastSeenAt, "Never")}</p></div>
                    <UserCheck className={cn("mt-1 size-5 shrink-0", user.approved ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")} />
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
      <EngineeringCorrectionsReport />
    </section>
  );
}
