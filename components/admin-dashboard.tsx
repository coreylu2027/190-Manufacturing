"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, ShieldCheck, UserCheck, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminResponse, AdminUserSummary, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

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

export function AdminDashboard() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin"], queryFn: fetchAdmin });
  const [roleDrafts, setRoleDrafts] = useState<Record<string, UserRole>>({});

  const userMutation = useMutation({
    mutationFn: ({ user, role, approved }: { user: AdminUserSummary; role: UserRole; approved: boolean }) => updateUser(user, role, approved),
    onSuccess: () => {
      toast.success("Account access updated");
      queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update account"),
  });

  const stats = useMemo(() => ({
    pendingUsers: query.data?.users.filter((user) => !user.approved).length ?? 0,
    approvedUsers: query.data?.users.filter((user) => user.approved).length ?? 0,
  }), [query.data]);

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

      {query.isLoading ? (
        <Skeleton className="h-[520px] rounded-2xl" />
      ) : query.isError ? (
        <div className="grid min-h-80 place-items-center rounded-2xl border bg-card p-6 text-center"><div><ShieldCheck className="mx-auto mb-3 size-10 text-destructive" /><h2 className="font-semibold">Couldn’t load the admin workspace</h2><p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
          <div className="border-b bg-muted/25 px-4 py-3"><h2 className="font-semibold">User approvals</h2><p className="mt-0.5 text-xs text-muted-foreground">Every new account starts pending with the machinist role.</p></div>
          {query.data?.users.length ? <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            {query.data.users.map((user) => {
              const role = roleDrafts[user.id] ?? user.role;
              return (
                <article key={user.id} className="border-b p-4 lg:[&:nth-last-child(-n+2)]:border-b-0">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate font-semibold">{user.name}</h3><Badge variant="outline" className={user.approved ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}>{user.approved ? "Approved" : "Pending"}</Badge></div><p className="mt-1 truncate text-xs text-muted-foreground">{user.email}</p><p className="mt-1 text-[11px] text-muted-foreground">Joined {formatDate(user.createdAt)} · Last opened {formatDate(user.lastSeenAt)}</p></div><UserCheck className={cn("mt-1 size-5 shrink-0", user.approved ? "text-emerald-600" : "text-muted-foreground")} /></div>
                  <div className="mt-3 flex items-center gap-2"><Select value={role} onValueChange={(value) => setRoleDrafts((current) => ({ ...current, [user.id]: (value ?? "machinist") as UserRole }))}><SelectTrigger className="h-9 min-w-0 flex-1"><SelectValue>{role === "admin" ? "Administrator" : "Machinist"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="machinist">Machinist</SelectItem><SelectItem value="admin">Administrator</SelectItem></SelectContent></Select><Button variant={user.approved ? "outline" : "default"} className="h-9" disabled={userMutation.isPending} onClick={() => userMutation.mutate({ user, role, approved: !user.approved })}>{user.approved ? "Revoke" : "Approve"}</Button>{user.approved && role !== user.role && <Button className="h-9" disabled={userMutation.isPending} onClick={() => userMutation.mutate({ user, role, approved: true })}>Save role</Button>}</div>
                </article>
              );
            })}
          </div> : <div className="grid min-h-60 place-items-center p-6 text-center"><div><Users className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h3 className="font-semibold">No users to manage</h3><p className="mt-1 text-sm text-muted-foreground">Registered accounts will appear here.</p></div></div>}
        </div>
      )}
    </section>
  );
}
