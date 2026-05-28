import { useReferenceData } from "../../data/referenceDataContext";

export function Avatar({ user, size }: { user: string; size?: "md" | "lg" }) {
  const { users } = useReferenceData();
  const entry = users[user] || { name: user, color: "#5a5a62" };
  const initials = entry.name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const cls = size === "md" ? "avatar avatar--md" : size === "lg" ? "avatar avatar--lg" : "avatar";
  return (
    <span className={cls} style={{ background: entry.color, color: "#0c0c0e" }}>
      {initials}
    </span>
  );
}
