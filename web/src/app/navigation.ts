import type { AppTab } from "../types/symphony";

export const appTabs: Array<{ id: AppTab; label: string; badge?: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "issues", label: "Issues", badge: "11" },
  { id: "history", label: "Chat history", badge: "4 live" },
  { id: "sidebar", label: "Sidebars" },
  { id: "states", label: "States" },
];
