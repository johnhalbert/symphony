import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ConnectionState } from "./connectionState";

export interface WebviewHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  initialState: ConnectionState | null;
}

export interface ConfiguredWebview {
  html: string;
  webviewRoot: vscode.Uri;
}

export function configureSymphonyWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  initialState: ConnectionState | null,
): ConfiguredWebview {
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  webview.options = {
    enableScripts: true,
    localResourceRoots: [webviewRoot],
  };

  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "main.js")).toString();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "styles.css")).toString();

  return {
    webviewRoot,
    html: renderSymphonyWebviewHtml({
      nonce,
      cspSource: webview.cspSource,
      scriptUri,
      styleUri,
      initialState,
    }),
  };
}

export function renderSymphonyWebviewHtml(options: WebviewHtmlOptions): string {
  const initialState = JSON.stringify(options.initialState).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource} 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';">
  <link nonce="${options.nonce}" rel="stylesheet" href="${options.styleUri}">
  <title>Symphony</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${options.nonce}">window.__SYMPHONY_INITIAL_STATE__ = ${initialState};</script>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}

export function createNonce(): string {
  return randomBytes(16).toString("base64");
}
