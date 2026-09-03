import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { AppRoutes } from "@/App";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling drives freshness; cached data keeps the UI responsive.
      staleTime: Number.POSITIVE_INFINITY,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
