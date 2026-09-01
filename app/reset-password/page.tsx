"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) return setError("Passwords do not match.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    const supabase = createClient();
    if (!supabase) return setError("Supabase is not configured yet.");
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <AuthShell title="Choose a new password" description="Set a new password for your manufacturing account.">
      <form className="mt-7 grid gap-4" onSubmit={updatePassword}><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="password">New password</label><Input id="password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11" /></div><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="confirm-password">Confirm new password</label><Input id="confirm-password" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required className="h-11" /></div><Button type="submit" size="lg" className="h-11" disabled={loading}>{loading ? "Updating password…" : "Update password"}</Button></form>
      {error && <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    </AuthShell>
  );
}
