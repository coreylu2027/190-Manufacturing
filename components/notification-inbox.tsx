"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import type { AppNotification } from "@/lib/types";

interface NotificationsResponse {
  notifications: AppNotification[];
}

async function fetchNotifications(): Promise<NotificationsResponse> {
  const response = await fetch("/api/notifications", { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Unable to load alerts");
  }
  return response.json();
}

function notificationFromRecord(record: Record<string, unknown>): AppNotification | null {
  if (
    typeof record.id !== "string"
    || typeof record.type !== "string"
    || typeof record.title !== "string"
    || typeof record.message !== "string"
    || typeof record.created_at !== "string"
  ) return null;

  return {
    id: record.id,
    type: record.type,
    title: record.title,
    message: record.message,
    data: record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : {},
    createdAt: record.created_at,
  };
}

export function NotificationInbox({ userId }: { userId: string | null }) {
  const queryClient = useQueryClient();
  const [realtimeUserId, setRealtimeUserId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: fetchNotifications,
    enabled: Boolean(userId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: userId && realtimeUserId !== userId ? 10_000 : false,
  });

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    if (!supabase) return;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const subscribe = async () => {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) {
        console.error("Notification realtime authentication failed", sessionError);
        return;
      }
      await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;

      channel = supabase
        .channel(`notifications:${userId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `recipient_id=eq.${userId}`,
          },
          (payload) => {
            const notification = notificationFromRecord(payload.new);
            if (!notification) return;
            queryClient.setQueryData<NotificationsResponse>(["notifications"], (existing) => {
              if (existing?.notifications.some((item) => item.id === notification.id)) return existing;
              return {
                notifications: [...(existing?.notifications ?? []), notification]
                  .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
              };
            });
          },
        )
        .subscribe((status, error) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setRealtimeUserId(userId);
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setRealtimeUserId((connectedUserId) => connectedUserId === userId ? null : connectedUserId);
            if (status !== "CLOSED") console.error("Notification realtime subscription failed", error);
          }
        });
    };
    void subscribe();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [queryClient, userId]);

  const current = query.data?.notifications[0] ?? null;
  const mutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/notifications/${id}`, { method: "PATCH" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Unable to acknowledge alert");
      }
    },
    onSuccess: (_data, id) => {
      queryClient.setQueryData<NotificationsResponse>(["notifications"], (existing) => ({
        notifications: existing?.notifications.filter((notification) => notification.id !== id) ?? [],
      }));
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to acknowledge alert"),
  });

  return (
    <Dialog open={Boolean(current)} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false}>
        {current && (
          <>
            <DialogHeader>
              <div className="mb-1 grid size-10 place-items-center rounded-full bg-amber-100 text-amber-800"><BellRing className="size-5" /></div>
              <DialogTitle>{current.title}</DialogTitle>
              <DialogDescription>{current.message}</DialogDescription>
            </DialogHeader>
            {query.data && query.data.notifications.length > 1 && (
              <p className="text-xs text-muted-foreground">1 of {query.data.notifications.length} unread alerts</p>
            )}
            <DialogFooter>
              <Button onClick={() => mutation.mutate(current.id)} disabled={mutation.isPending}>
                {mutation.isPending && <LoaderCircle className="animate-spin" />} Acknowledge
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
