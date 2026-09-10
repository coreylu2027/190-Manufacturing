"use client";

import { useSyncExternalStore } from "react";

export type DetailView = "panel" | "expanded";
const key = "frc190-detail-view";
const eventName = "frc190-detail-view-change";
let fallback: DetailView = "panel";

function snapshot(): DetailView {
  try {
    const saved = localStorage.getItem(key);
    return saved === "expanded" ? "expanded" : "panel";
  } catch {
    return fallback;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(eventName, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(eventName, callback);
  };
}

export function setDetailView(value: DetailView) {
  fallback = value;
  let saved = true;
  try { localStorage.setItem(key, value); } catch { saved = false; }
  window.dispatchEvent(new Event(eventName));
  return saved;
}

export function useDetailView() {
  return useSyncExternalStore(subscribe, snapshot, () => "panel" as const);
}
