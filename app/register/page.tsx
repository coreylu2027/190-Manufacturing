"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatShopName, shopNameSchema } from "@/lib/profile-name";
import { createClient } from "@/lib/supabase/client";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastInitial, setLastInitial] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsedName = shopNameSchema.safeParse({ firstName, lastInitial });
    if (!parsedName.success) return setError(parsedName.error.issues[0]?.message ?? "Enter a valid shop name.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    const supabase = createClient();
    if (!supabase) return setError("Supabase is not configured yet.");
    setLoading(true);
    const displayName = formatShopName(parsedName.data.firstName, parsedName.data.lastInitial);
    const { error: authError } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${window.location.origin}/auth/callback`, data: { full_name: displayName } } });
    setLoading(false);
    if (authError) return setError(authError.message);
    setSuccess(true);
  }

  return (
    <AuthShell title="Create your account" description="Choose the shop name that will appear on claimed and completed work. An administrator will approve the account and assign your role." footer={<Link href="/login" className="font-semibold text-primary hover:underline">Back to sign in</Link>}>
      {success ? (
        <div className="mt-7 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><p className="font-semibold">Registration received</p><p className="mt-1 leading-6">Check your email to confirm the address if requested. After confirmation, your account will wait for administrator approval.</p></div>
      ) : (
        <form className="mt-7 grid gap-4" onSubmit={register}>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3"><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="first-name">First name</label><Input id="first-name" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required className="h-11" /></div><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="last-initial">Last initial</label><Input id="last-initial" autoComplete="family-name" maxLength={1} value={lastInitial} onChange={(event) => setLastInitial(event.target.value)} required className="h-11 uppercase" /></div></div>
          <div><label className="mb-1.5 block text-xs font-semibold" htmlFor="email">Email</label><Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11" /></div>
          <div><label className="mb-1.5 block text-xs font-semibold" htmlFor="password">Password</label><Input id="password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11" /><p className="mt-1.5 text-[11px] text-muted-foreground">At least 8 characters.</p></div>
          <div><label className="mb-1.5 block text-xs font-semibold" htmlFor="confirm-password">Confirm password</label><Input id="confirm-password" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required className="h-11" /></div>
          <Button type="submit" size="lg" className="h-11" disabled={loading}>{loading ? "Creating account…" : "Register"}</Button>
        </form>
      )}
      {error && <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    </AuthShell>
  );
}
