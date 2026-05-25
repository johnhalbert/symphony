import * as vscode from "vscode";
import { SymphonyClient } from "./symphonyClient";
import { SymphonyPanelProvider } from "./webviewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SymphonyPanelProvider(context.extensionUri, new SymphonyClient());

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(SymphonyPanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("symphony.openPanel", () => provider.openPanel()),
    vscode.commands.registerCommand("symphony.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "symphony.baseUrl"),
    ),
    vscode.commands.registerCommand("symphony.refresh", () => provider.refreshDashboard("command")),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("symphony.baseUrl") || event.affectsConfiguration("symphony.token")) {
        void provider.refreshDashboard("config");
      }
    }),
  );

  void provider.refreshDashboard("activate");
}

export function deactivate(): void {
  // Disposables registered in activate are released by the extension host.
}
