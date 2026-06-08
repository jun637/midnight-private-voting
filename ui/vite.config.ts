import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI does no on-chain work itself — it calls the local server's REST API.
// /api is proxied to the server so the browser can use same-origin requests.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind 0.0.0.0 so Windows can reach the WSL2 dev server
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
