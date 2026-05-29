import { useReferenceData } from "../../data/referenceDataContext";
import { referenceColor, referenceDisplayName } from "../../data/referenceData";

export function Avatar({ user, size }: { user: string; size?: "md" | "lg" }) {
  const { users } = useReferenceData();
  const entry = users[user];
  const displayName = referenceDisplayName(user, entry);
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const cls = size === "md" ? "avatar avatar--md" : size === "lg" ? "avatar avatar--lg" : "avatar";
  return (
    <span className={cls} style={{ background: referenceColor(entry), color: "#0c0c0e" }}>
      {initials}
    </span>
  );
}
