import { useReferenceData } from "../../data/referenceDataContext";
import { referenceColor, referenceDisplayName } from "../../data/referenceData";

export function Label({ name }: { name: string }) {
  const { labels } = useReferenceData();
  const entry = labels[name];
  return (
    <span className="label">
      <span className="swatch" style={{ background: referenceColor(entry) }} />
      {referenceDisplayName(name, entry)}
    </span>
  );
}
