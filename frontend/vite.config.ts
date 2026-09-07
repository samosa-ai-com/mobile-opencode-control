import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv("", repoRoot, "");
const backendPort = env.BACKEND_PORT || process.env.BACKEND_PORT || "38473";
const allowedHosts = (env.VITE_ALLOWED_HOSTS || env.FRONTEND_ALLOWED_HOSTS || process.env.VITE_ALLOWED_HOSTS || process.env.FRONTEND_ALLOWED_HOSTS || "localhost,127.0.0.1")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts,
    proxy: {
      "/api": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        proxyTimeout: 30000,
        timeout: 30000,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.includes("/stream")) {
              proxyReq.setHeader("Connection", "keep-alive");
            }
          });
          proxy.on("proxyRes", (proxyRes, req) => {
            if (req.url?.includes("/stream")) {
              delete proxyRes.headers["content-length"];
            }
          });
          proxy.on("error", (err, _req, res) => {
            if (res && !res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Backend unavailable: ${err.message}` }));
            }
          });
        },
      },
    },
  },
});
