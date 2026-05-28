import { useReferenceData } from "../../data/referenceDataContext";

export function Label({ name }: { name: string }) {
  const { labels } = useReferenceData();
  const entry = labels[name] || { name, color: "#5a5a62" };
  return (
    <span className="label">
      <span className="swatch" style={{ background: entry.color }} />
      {entry.name}
    </span>
  );
}
