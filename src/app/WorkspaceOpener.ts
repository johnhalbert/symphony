export interface WorkspaceOpener {
  open(workspacePath: string): Promise<void>;
}
