"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { colorThemeScript, useColorTheme } from "@/lib/color-theme-preference";

export function Providers({ children }: { children: React.ReactNode }) {
  const colorTheme = useColorTheme();
  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme;
  }, [colorTheme]);
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
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <script dangerouslySetInnerHTML={{ __html: colorThemeScript }} />
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-left" mobileOffset={{ bottom: "88px", left: "16px", right: "16px" }} richColors />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
