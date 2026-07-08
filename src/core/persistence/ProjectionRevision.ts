export type ProjectionChangeSource =
  | "runs"
  | "run_metadata"
  | "workspaces"
  | "lifecycle"
  | "writeback"
  | "orchestrator_conversations"
  | "run_activity";

export type ProjectionChangeDetail = Readonly<Record<string, unknown>>;

export interface ProjectionChangeEvent {
  source: ProjectionChangeSource;
  revision: number;
  detail?: ProjectionChangeDetail | null;
}

export type ProjectionChangeListener = (event: ProjectionChangeEvent) => void;
export type ProjectionChangeUnsubscribe = () => void;

export class ProjectionRevisionNotifier {
  private revision = 0;
  private readonly listeners = new Set<ProjectionChangeListener>();

  currentRevision(): number {
    return this.revision;
  }

  subscribe(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(source: ProjectionChangeSource, detail: ProjectionChangeDetail | null = null): void {
    this.revision += 1;
    const event: ProjectionChangeEvent = detail === null ? { source, revision: this.revision } : { source, revision: this.revision, detail };
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // Projection listeners are cache invalidation observers. Durable writes have
        // already succeeded, so observer failures must not corrupt the write path.
      }
    }
  }
}
