export function manufacturingSupabaseConfig(env: Record<string, string | undefined> = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = (env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !serviceKey) {
    throw new Error("Supabase manufacturing credentials are missing");
  }
  return { url, serviceKey };
}
