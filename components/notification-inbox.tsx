"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, LoaderCircle } from "lucide-react";
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

export function NotificationInbox({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: fetchNotifications,
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
  });
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
