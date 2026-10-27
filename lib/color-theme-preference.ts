"use client";

import { createBrowserPreference } from "@/lib/browser-preference";

export type ColorTheme = "current" | "190";
const key = "frc190-color-theme";

const preference = createBrowserPreference<ColorTheme>(key, "current", "190", (value) => {
  document.documentElement.dataset.colorTheme = value;
});

export const setColorTheme = preference.set;
export const useColorTheme = preference.use;

// Restore before first paint, independently of next-themes' light/dark class.
export const colorThemeScript = `try{document.documentElement.dataset.colorTheme=localStorage.getItem(${JSON.stringify(key)})==="190"?"190":"current"}catch{}`;
