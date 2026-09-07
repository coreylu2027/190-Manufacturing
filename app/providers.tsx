"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      // A failed snapshot read is already expensive. Automatic retries used to
      // multiply a single Realtime refresh into several simultaneous database
      // reads, which could overwhelm the small Supabase instance.
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 0 },
      mutations: { retry: 0 },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  );
}
