import { createClient } from "@/lib/supabase/client";

type BrowserClient = NonNullable<ReturnType<typeof createClient>>;
type Channel = ReturnType<BrowserClient["channel"]>;

/**
 * Joins a realtime channel with the signed-in user's token. `onDisconnected` runs when
 * authentication fails or the channel errors, times out or closes. Returns the cleanup
 * that leaves the channel; nothing happens when Supabase is not configured.
 */
export function joinAuthorizedChannel(
  label: string,
  createChannel: (supabase: BrowserClient) => Channel,
  { onSubscribed, onDisconnected }: { onSubscribed: () => void; onDisconnected: () => void },
) {
  const supabase = createClient();
  if (!supabase) return () => {};
  let cancelled = false;
  let channel: Channel | null = null;

  const join = async () => {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      if (!cancelled) onDisconnected();
      console.error(`${label} realtime authentication failed`, sessionError);
      return;
    }

    await supabase.realtime.setAuth(session.access_token);
    if (cancelled) return;

    channel = createChannel(supabase).subscribe((status, error) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") {
        onSubscribed();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        onDisconnected();
        if (status !== "CLOSED") console.error(`${label} realtime subscription failed`, error);
      }
    });
  };
  join().catch((error) => {
    if (!cancelled) onDisconnected();
    console.error(`${label} realtime subscription failed`, error);
  });

  return () => {
    cancelled = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
