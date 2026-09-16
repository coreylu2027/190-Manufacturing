"use client";

import { useState, useSyncExternalStore } from "react";
import { Monitor, Moon, Settings2, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { setDetailView, useDetailView } from "@/lib/detail-view-preference";
import { setColorTheme, useColorTheme } from "@/lib/color-theme-preference";

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function PreferencesPage() {
  const view = useDetailView();
  const colorTheme = useColorTheme();
  const [themeMessage, setThemeMessage] = useState("");
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const [message, setMessage] = useState("");
  return (
    <section className="mx-auto max-w-5xl px-4 py-7 md:px-7 md:py-10">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><Settings2 className="size-4" /> Your workspace</div>
      <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Preferences</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">Make the shop workspace work for you.</p>
      <div className="mt-7 rounded-2xl border bg-card p-5 shadow-sm md:p-7">
        <fieldset disabled={!hydrated}>
          <legend className="text-lg font-semibold">Theme</legend>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Choose your workspace colors. Both themes support Auto, Light, and Dark appearance.</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {([
              { value: "current", title: "Current", description: "The original blue and slate workspace.", colors: ["#3159c6", "#697386", "#f7f9fc"] },
              { value: "190", title: "FRC 190", description: "WPI crimson and gray with neutral surfaces.", colors: ["#ac2b37", "#a9b0b7", "#202124"] },
            ] as const).map((option) => (
              <label key={option.value} className={cn("cursor-pointer rounded-xl border p-4 transition hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring", colorTheme === option.value ? "border-primary bg-primary/5" : "bg-background")}>
                <div aria-hidden="true" className="mb-4 flex gap-2">{option.colors.map((color) => <span key={color} className="size-8 rounded-full border" style={{ backgroundColor: color }} />)}</div>
                <div className="flex items-center gap-2.5"><input type="radio" name="color-theme" value={option.value} checked={colorTheme === option.value} onChange={() => setThemeMessage(setColorTheme(option.value) ? "Theme saved." : "Applied for this session. Browser storage is unavailable.")} className="size-4 accent-primary" /><span className="font-semibold">{option.title}</span></div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{option.description}</p>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-5 text-xs leading-5 text-muted-foreground">Saved automatically in this browser.</p>
        <p role="status" className="mt-2 min-h-5 text-xs font-medium text-primary">{themeMessage}</p>
      </div>
      <div className="mt-7 rounded-2xl border bg-card p-5 shadow-sm md:p-7">
        <fieldset disabled={!hydrated}>
          <legend className="text-lg font-semibold">Appearance</legend>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Choose light or dark appearance, or automatically match your system setting.</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {([
              { value: "system", title: "Auto", description: "Match your system’s light or dark setting.", icon: Monitor },
              { value: "light", title: "Light", description: "Always use the light theme.", icon: Sun },
              { value: "dark", title: "Dark", description: "Always use the dark theme.", icon: Moon },
            ] as const).map(({ icon: Icon, ...option }) => (
              <label key={option.value} className={cn("cursor-pointer rounded-xl border p-4 transition hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring", hydrated && theme === option.value ? "border-primary bg-primary/5" : "bg-background")}>
                <Icon aria-hidden="true" className="mb-4 size-6 text-primary" />
                <div className="flex items-center gap-2.5">
                  <input type="radio" name="appearance" value={option.value} checked={hydrated && theme === option.value} onChange={() => setTheme(option.value)} className="size-4 accent-primary" />
                  <span className="font-semibold">{option.title}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{option.description}</p>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-5 text-xs leading-5 text-muted-foreground">Saved automatically in this browser. Auto follows system theme changes.</p>
      </div>
      <div className="mt-7 rounded-2xl border bg-card p-5 shadow-sm md:p-7">
        <fieldset>
          <legend className="text-lg font-semibold">Detail view</legend>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Choose how details open from Open, Claim, Steal, More details, and Review in the tables.</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {([
              { value: "panel", title: "Side panel", description: "The familiar panel on the right, with sections stacked vertically." },
              { value: "expanded", title: "Expanded window", description: "A large, centered window with sections side by side, so you can see more at once." },
            ] as const).map((option) => (
              <label key={option.value} className={cn("cursor-pointer rounded-xl border p-4 transition hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring", view === option.value ? "border-primary bg-primary/5" : "bg-background")}>
                <div aria-hidden="true" className="relative mb-4 h-36 overflow-hidden rounded-lg border bg-muted/40 p-3">
                  <div className="h-2 w-16 rounded bg-muted-foreground/20" />
                  <div className={cn("absolute rounded-md border bg-card p-3 shadow-sm", option.value === "panel" ? "inset-y-0 right-0 w-2/5 rounded-r-none" : "inset-x-5 inset-y-5")}>
                    <div className="mb-3 h-2 w-2/3 rounded bg-primary/40" />
                    <div className={cn("grid gap-2", option.value === "expanded" && "grid-cols-3")}>
                      {Array.from({ length: 3 }, (_, index) => <div key={index} className="h-12 rounded border bg-muted/50" />)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2.5"><input type="radio" name="detail-view" value={option.value} checked={view === option.value} onChange={() => setMessage(setDetailView(option.value) ? "Preference saved." : "Applied for this session. Browser storage is unavailable.")} className="size-4 accent-primary" /><span className="font-semibold">{option.title}</span></div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{option.description}</p>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-5 text-xs leading-5 text-muted-foreground">Saved automatically in this browser. Expanded windows adapt to your screen; long records can still scroll.</p>
        <p role="status" className="mt-2 min-h-5 text-xs font-medium text-primary">{message}</p>
      </div>
    </section>
  );
}
