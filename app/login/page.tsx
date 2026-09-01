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
  const [loading, setLoading] = useState<string | null>(null);
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
    setLoading("password");
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (authError) {
      setError(authError.message);
      setLoading(null);
      return;
    }
    await finishSignIn();
  }

  async function signIn(provider: "google" | "azure") {
    const supabase = createClient();
    if (!supabase) return setError("Supabase is not configured yet.");
    setError(null);
    setLoading(provider);
    const { error: authError } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: `${window.location.origin}/auth/callback`, scopes: provider === "azure" ? "email openid profile" : undefined } });
    if (authError) {
      setError(authError.message);
      setLoading(null);
    }
  }

  return (
    <AuthShell title="Sign in to the shop" description="Use your approved team account so every operation is attributed to the person who performed it." footer={<>New accounts require administrator approval before shop access.</>}>
      <form className="mt-7 grid gap-4" onSubmit={signInWithPassword}>
        <div><label className="mb-1.5 block text-xs font-semibold" htmlFor="email">Email</label><Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11" /></div>
        <div><div className="mb-1.5 flex items-center justify-between"><label className="text-xs font-semibold" htmlFor="password">Password</label><Link href="/forgot-password" className="text-xs font-semibold text-primary hover:underline">Forgot password?</Link></div><Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required className="h-11" /></div>
        <Button type="submit" size="lg" className="h-11" disabled={Boolean(loading)}>{loading === "password" ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="my-5 flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
      <div className="grid grid-cols-2 gap-3"><Button variant="outline" className="h-10" onClick={() => signIn("google")} disabled={Boolean(loading)}>{loading === "google" ? "Opening…" : "Google"}</Button><Button variant="outline" className="h-10" onClick={() => signIn("azure")} disabled={Boolean(loading)}>{loading === "azure" ? "Opening…" : "Microsoft"}</Button></div>
      {error && <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <p className="mt-5 text-center text-sm text-muted-foreground">Need an account? <Link href="/register" className="font-semibold text-primary hover:underline">Register</Link></p>
    </AuthShell>
  );
}
