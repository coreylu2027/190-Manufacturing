"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createClient();
    if (!supabase) return setMessage("Supabase is not configured yet.");
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/auth/callback?next=/reset-password` });
    setLoading(false);
    setMessage(error ? error.message : "If an account exists for that email, a password reset link has been sent.");
  }

  return (
    <AuthShell title="Reset your password" description="Enter your account email and we’ll send a secure password reset link." footer={<Link href="/login" className="font-semibold text-primary hover:underline">Back to sign in</Link>}>
      <form className="mt-7 grid gap-4" onSubmit={requestReset}><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="email">Email</label><Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required className="h-11" /></div><Button type="submit" size="lg" className="h-11" disabled={loading}>{loading ? "Sending link…" : "Send reset link"}</Button></form>
      {message && <p className="mt-4 rounded-lg bg-muted p-3 text-sm">{message}</p>}
    </AuthShell>
  );
}
