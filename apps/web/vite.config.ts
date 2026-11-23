import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 127.0.0.1: in development the server listens only there, and "localhost" may resolve to ::1.
const server = process.env.REIMBURSEMENTS_SERVER_URL ?? "http://127.0.0.1:8000";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Separate caches let several dev servers of this project run at once.
  cacheDir: process.env.VITE_CACHE_DIR ?? "node_modules/.vite",
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    // The API, the sign-in redirects and the health checks come from the
    // server; keep the Host header so cookies and origins match APP_URL
    // (http://localhost:5173 while developing with Vite).
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/oidc": { target: server, changeOrigin: false },
      "/-": { target: server, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      output: {
        // Source paths from the repository root (app:///apps/web/src/…), the
        // same on every host, so that error reports link to the code (Sentry
        // code mapping app:/// → repository root).
        sourcemapPathTransform: (source, sourcemapPath) =>
          `app:///${path.relative(repositoryRoot, path.resolve(path.dirname(sourcemapPath), source))}`,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
