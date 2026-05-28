import type { PriorityLevel } from "../../types/symphony";

export function Priority({ level }: { level: PriorityLevel }) {
  return (
    <span className="pri-bars" data-level={level}>
      <span />
      <span />
      <span />
    </span>
  );
}

export function priorityWeight(priority: PriorityLevel): number {
  return priority === "urgent" ? 4 : priority;
}
