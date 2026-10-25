"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shopNameSchema } from "@/lib/profile-name";
import { errorStatus, requestJson } from "@/lib/request-json";

/** Lets a pending account move off a shop name another account already holds, which blocks its approval. */
export function PendingShopName({ name }: { name: string }) {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastInitial, setLastInitial] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed = shopNameSchema.safeParse({ firstName, lastInitial });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Enter a valid shop name.");
    setSaving(true);
    try {
      await requestJson("/api/account", { method: "PATCH", body: JSON.stringify(parsed.data) }, "Unable to update your shop name.");
      router.refresh();
    } catch (caught) {
      setError(errorStatus(caught) === undefined ? "Unable to reach the server. Try again." : (caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mt-4 grid gap-3 rounded-xl border p-4 text-sm" onSubmit={save}>
      <p>Another account already uses the shop name <span className="font-semibold">{name}</span>. Choose a different one so an administrator can approve this account.</p>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3"><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="pending-first-name">First name</label><Input id="pending-first-name" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></div><div><label className="mb-1.5 block text-xs font-semibold" htmlFor="pending-last-initial">Last initial</label><Input id="pending-last-initial" autoComplete="family-name" maxLength={1} value={lastInitial} onChange={(event) => setLastInitial(event.target.value)} required className="uppercase" /></div></div>
      <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Change shop name"}</Button>
      {error && <p className="rounded-lg bg-destructive/10 p-3 text-destructive">{error}</p>}
    </form>
  );
}
