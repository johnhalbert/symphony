import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { resolveApiProxyTarget } from "./src/config/apiProxyConfig";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiProxyTarget = resolveApiProxyTarget(env);

  return {
    base: "/web/",
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
