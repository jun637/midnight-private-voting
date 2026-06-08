import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI does no on-chain work itself — it calls the local server's REST API.
// /api is proxied to the server so the browser can use same-origin requests.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind 0.0.0.0 so Windows can reach the WSL2 dev server
    port: 5173,
    // The project lives on /mnt/d (Windows drive): WSL doesn't deliver inotify
    // events for it, so vite's watcher misses edits and HMR never fires.
    // Polling makes file changes detectable -> live HMR while iterating.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
