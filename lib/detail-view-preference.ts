"use client";

import { createBrowserPreference } from "@/lib/browser-preference";

export type DetailView = "panel" | "expanded";

const preference = createBrowserPreference<DetailView>("frc190-detail-view", "panel", "expanded");

export const setDetailView = preference.set;
export const useDetailView = preference.use;
