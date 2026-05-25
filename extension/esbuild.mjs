import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/webview", { recursive: true });
mkdirSync("dist/media", { recursive: true });

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  external: ["vscode"],
  sourcemap: true,
  target: "node18",
});

await build({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview/main.js",
  format: "iife",
  platform: "browser",
  sourcemap: true,
  target: "es2022",
});

cpSync("src/webview/index.html", "dist/webview/index.html");
cpSync("src/webview/styles.css", "dist/webview/styles.css");
cpSync("media/icon.svg", "dist/media/icon.svg");
