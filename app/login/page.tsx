"use client";

import { Factory } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(provider: "google" | "azure") {
    const supabase = createClient();
    if (!supabase) {
      setError("Supabase is not configured yet. Add the public URL and anonymous key to enable sign-in.");
      return;
    }
    setLoading(provider);
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: provider === "azure" ? "email openid profile" : undefined,
      },
    });
    if (authError) {
      setError(authError.message);
      setLoading(null);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,oklch(0.9_0.08_260),transparent_42%),var(--background)] p-5">
      <div className="w-full max-w-md rounded-3xl border bg-card p-8 shadow-[0_24px_80px_rgba(15,23,42,.14)]">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground"><Factory /></div>
          <div><p className="font-bold">FRC 190</p><p className="text-xs uppercase tracking-[.18em] text-muted-foreground">Manufacturing OS</p></div>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Sign in to the shop</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Use your team account so every operation is attributed to the machinist who performed it.</p>
        <div className="mt-7 grid gap-3">
          <Button size="lg" variant="outline" className="h-11 justify-center" onClick={() => signIn("google")} disabled={Boolean(loading)}>
            {loading === "google" ? "Opening Google…" : "Continue with Google"}
          </Button>
          <Button size="lg" className="h-11 justify-center" onClick={() => signIn("azure")} disabled={Boolean(loading)}>
            {loading === "azure" ? "Opening Microsoft…" : "Continue with Microsoft"}
          </Button>
        </div>
        {error && <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        <p className="mt-7 text-xs leading-5 text-muted-foreground">Access is intended for FRC 190 manufacturing members. Authorization remains enforced server-side.</p>
      </div>
    </main>
  );
}
