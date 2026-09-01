import { Factory } from "lucide-react";

export function AuthShell({ title, description, children, footer }: { title: string; description: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,oklch(0.9_0.08_260),transparent_42%),var(--background)] p-5">
      <div className="w-full max-w-md rounded-3xl border bg-card p-8 shadow-[0_24px_80px_rgba(15,23,42,.14)]">
        <div className="mb-8 flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground"><Factory /></div><div><p className="font-bold">FRC 190</p><p className="text-xs uppercase tracking-[.18em] text-muted-foreground">Manufacturing OS</p></div></div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        {children}
        {footer && <div className="mt-7 border-t pt-5 text-center text-xs leading-5 text-muted-foreground">{footer}</div>}
      </div>
    </main>
  );
}
