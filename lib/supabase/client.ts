import { createBrowserClient } from "@supabase/ssr";

function browserConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

/** Whether createClient() can build a browser client; cheap enough to check during render. */
export function isSupabaseConfigured() {
  return browserConfig() !== null;
}

export function createClient() {
  const config = browserConfig();
  return config ? createBrowserClient(config.url, config.key) : null;
}
