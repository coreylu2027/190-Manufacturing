"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finishSignIn() {
    const response = await fetch("/api/account", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    router.replace(body.user?.approved ? "/" : "/pending");
    router.refresh();
  }

  async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createClient();
    if (!supabase) return setError("Supabase is not configured yet.");
    setError(null);
    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }
    await finishSignIn();
  }

  return (
    <AuthShell title="Sign in to the shop" description="Use your approved team account so every operation is attributed to the person who performed it." footer={<>New accounts require administrator approval before shop access.</>}>
      <form className="mt-7 grid gap-4" onSubmit={signInWithPassword}>
        <div><label className="mb-1.5 block text-xs font-semibold" htmlFor="email">Email</label><Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11" /></div>
        <div><div className="mb-1.5 flex items-center justify-between"><label className="text-xs font-semibold" htmlFor="password">Password</label><Link href="/forgot-password" className="text-xs font-semibold text-primary hover:underline">Forgot password?</Link></div><Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11" /></div>
        <Button type="submit" size="lg" className="h-11" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</Button>
      </form>
      {error && <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <p className="mt-5 text-center text-sm text-muted-foreground">Need an account? <Link href="/register" className="font-semibold text-primary hover:underline">Register</Link></p>
    </AuthShell>
  );
}
