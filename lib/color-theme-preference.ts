"use client";

import { useSyncExternalStore } from "react";

export type ColorTheme = "current" | "190";
const key = "frc190-color-theme";
const eventName = "frc190-color-theme-change";
let fallback: ColorTheme = "current";

function snapshot(): ColorTheme {
  try { return localStorage.getItem(key) === "190" ? "190" : "current"; }
  catch { return fallback; }
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(eventName, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(eventName, callback);
  };
}

export function setColorTheme(value: ColorTheme) {
  fallback = value;
  let saved = true;
  try { localStorage.setItem(key, value); } catch { saved = false; }
  document.documentElement.dataset.colorTheme = value;
  window.dispatchEvent(new Event(eventName));
  return saved;
}

export function useColorTheme() {
  return useSyncExternalStore(subscribe, snapshot, () => "current" as const);
}

// Restore before first paint, independently of next-themes' light/dark class.
export const colorThemeScript = `try{document.documentElement.dataset.colorTheme=localStorage.getItem("frc190-color-theme")==="190"?"190":"current"}catch{}`;
