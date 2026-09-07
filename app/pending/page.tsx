import { Clock3 } from "lucide-react";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { getAppUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const user = await getAppUser();
  if (!user) redirect("/login");
  if (user.approved) redirect("/");

  return (
    <AuthShell title="Approval pending" description="Your email is confirmed, but an administrator must approve the account and assign a role before you can enter the shop." footer={<>Signed in as {user.email}</>}>
      <div className="mt-7 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center text-amber-950"><Clock3 className="mx-auto size-9" /><p className="mt-3 font-semibold">Waiting for administrator review</p><p className="mt-1 text-sm leading-6">Ask a team administrator to approve your account. Reload this page after approval.</p></div>
      <div className="mt-4 grid grid-cols-2 gap-3"><Button nativeButton={false} render={<a href="/pending" />} variant="outline" className="h-10">Check again</Button><Button nativeButton={false} render={<a href="/auth/signout" />} variant="outline" className="h-10">Sign out</Button></div>
    </AuthShell>
  );
}
