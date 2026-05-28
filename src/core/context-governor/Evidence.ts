export interface EvidenceEvent {
  at: string;
  kind: string;
  payload: unknown;
}

export function evidenceEvent(kind: string, payload: unknown, now: Date = new Date()): EvidenceEvent {
  return { at: now.toISOString(), kind, payload };
}

export function serializeEvidenceEvent(event: EvidenceEvent): string {
  return `${JSON.stringify(event)}\n`;
}
