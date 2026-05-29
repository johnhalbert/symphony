import type { LabelDef, UserDef } from "../types/symphony";

export const fallbackReferenceColor = "#5a5a62";

type ReferenceEntry = Pick<LabelDef | UserDef, "name" | "color">;

export function referenceDisplayName(fallbackName: string, entry: ReferenceEntry | null | undefined): string {
  const name = entry?.name.trim();
  return name ? name : fallbackName;
}

export function referenceColor(entry: ReferenceEntry | null | undefined): string {
  return entry?.color || fallbackReferenceColor;
}
