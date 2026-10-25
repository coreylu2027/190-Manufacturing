"use client";

import { useSyncExternalStore } from "react";

/**
 * A two-valued preference saved in localStorage and shared with other tabs. When
 * storage is unavailable, the last value set still applies for this page.
 */
export function createBrowserPreference<T extends string>(key: string, defaultValue: T, alternateValue: T, onSet?: (value: T) => void) {
  const eventName = `${key}-change`;
  let fallback = defaultValue;

  function snapshot(): T {
    try { return localStorage.getItem(key) === alternateValue ? alternateValue : defaultValue; }
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

  /** Returns whether the value was saved, rather than applied for this page only. */
  function set(value: T) {
    fallback = value;
    let saved = true;
    try { localStorage.setItem(key, value); } catch { saved = false; }
    onSet?.(value);
    window.dispatchEvent(new Event(eventName));
    return saved;
  }

  function usePreference() {
    return useSyncExternalStore(subscribe, snapshot, () => defaultValue);
  }

  return { set, use: usePreference };
}
