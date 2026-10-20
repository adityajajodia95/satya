import "./zod-setup";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/newsreader/600.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles/tokens.css";
import "./styles/base.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TurnstileGate } from "aj-demo-kit";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ownerToken } from "./lib/api";

/** Public Turnstile site key (widget "aj-projects"); Cloudflare's always-pass test key in development. */
const SITE_KEY = import.meta.env.PROD ? "0x4AAAAAAFV1QTucPQRxveVD" : "1x00000000000000000000AA";

const queries = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <TurnstileGate siteKey={SITE_KEY} bypass={Boolean(ownerToken())}>
        <BrowserRouter basename="/satya">
          <App />
        </BrowserRouter>
      </TurnstileGate>
    </QueryClientProvider>
  </StrictMode>,
);
