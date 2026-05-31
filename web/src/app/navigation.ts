import type { AppTab } from "../types/symphony";

export const appTabs: Array<{ id: AppTab; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "issues", label: "Issues" },
  { id: "history", label: "Chat history" },
  { id: "sidebar", label: "Sidebars" },
  { id: "states", label: "States" },
];
