"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { requestJson } from "@/lib/request-json";
import { joinAuthorizedChannel } from "@/lib/supabase/realtime";
import type { AppNotification } from "@/lib/types";

interface NotificationsResponse {
  notifications: AppNotification[];
}

function fetchNotifications() {
  return requestJson<NotificationsResponse>("/api/notifications", { cache: "no-store" }, "Unable to load alerts");
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
  const router = useRouter();
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
    return joinAuthorizedChannel("Notification", (supabase) => supabase
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
      ), {
      onSubscribed: () => {
        setRealtimeUserId(userId);
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
      },
      onDisconnected: () => setRealtimeUserId((connectedUserId) => connectedUserId === userId ? null : connectedUserId),
    });
  }, [queryClient, userId]);

  const current = query.data?.notifications[0] ?? null;
  // Alerts may point at an in-app page, such as a staged Onshape sync to review.
  const href = typeof current?.data.href === "string" && current.data.href.startsWith("/") && !current.data.href.startsWith("//")
    ? current.data.href : null;
  const mutation = useMutation({
    mutationFn: (id: string) => requestJson(`/api/notifications/${id}`, { method: "PATCH" }, "Unable to acknowledge alert"),
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
              <div className="mb-1 grid size-10 place-items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"><BellRing className="size-5" /></div>
              <DialogTitle>{current.title}</DialogTitle>
              <DialogDescription>{current.message}</DialogDescription>
            </DialogHeader>
            {query.data && query.data.notifications.length > 1 && (
              <p className="text-xs text-muted-foreground">1 of {query.data.notifications.length} unread alerts</p>
            )}
            <DialogFooter>
              <Button variant={href ? "outline" : "default"} onClick={() => mutation.mutate(current.id)} disabled={mutation.isPending}>
                {mutation.isPending && <LoaderCircle className="animate-spin" />} Acknowledge
              </Button>
              {href && (
                <Button disabled={mutation.isPending} onClick={() => mutation.mutate(current.id, { onSuccess: () => router.push(href) })}>
                  Review now
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
