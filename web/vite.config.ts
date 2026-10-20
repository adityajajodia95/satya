import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served under /satya/ on the aj-demos Pages site; API calls go to the same origin (/api/satya/...).
// In development /api is proxied to the Pages site (local `wrangler pages dev` or the deployed one).
export default defineConfig({
  base: "/satya/",
  plugins: [react()],
  // aj-demo-kit is a file: dependency with its own node_modules; one React instance for the whole app.
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.SATYA_API_ORIGIN ?? "http://localhost:8788",
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
