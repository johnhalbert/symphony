import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { resolveApiProxyTarget } from "./src/config/apiProxyConfig";
import { resolveWebBasePath } from "./src/config/webBuildConfig";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiProxyTarget = resolveApiProxyTarget(env);
  const base = resolveWebBasePath(env, { command, mode });

  return {
    base,
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
