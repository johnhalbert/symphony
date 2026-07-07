import { errorMessage } from "../errors.js";
import type { ShutdownProgressAction, ShutdownProgressObserver } from "./ShutdownProgress.js";

interface ShutdownStatusStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
}

export interface ShutdownStatusLineOptions {
  stream: ShutdownStatusStream;
  graceMs: number;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

type ActionStatus = "started" | "completed" | "failed";

export class ShutdownStatusLine implements ShutdownProgressObserver {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private interval: unknown = null;
  private startedAtMs: number | null = null;
  private currentLabel = "starting shutdown";
  private forcedReason: string | null = null;
  private finishedStatus: string | null = null;
  private readonly actions = new Map<string, ActionStatus>();

  constructor(private readonly options: ShutdownStatusLineOptions) {
    this.enabled = options.stream.isTTY === true;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  }

  writeLogLine(line: string): void {
    if (!this.enabled || this.startedAtMs === null) {
      this.options.stream.write(`${line}\n`);
      return;
    }
    this.clearRenderedLine();
    this.options.stream.write(`${line}\n`);
    this.render();
  }

  started(action: ShutdownProgressAction): void {
    this.ensureStarted();
    this.actions.set(action.id, "started");
    this.currentLabel = action.label;
    this.render();
  }

  completed(action: ShutdownProgressAction): void {
    this.ensureStarted();
    this.actions.set(action.id, "completed");
    this.currentLabel = action.label;
    this.render();
  }

  failed(action: ShutdownProgressAction, error: unknown): void {
    this.ensureStarted();
    this.actions.set(action.id, "failed");
    this.currentLabel = `${action.label} failed: ${errorMessage(error)}`;
    this.render();
  }

  waiting(action: ShutdownProgressAction): void {
    this.ensureStarted();
    this.currentLabel = action.label;
    this.render();
  }

  forced(reason: string): void {
    this.ensureStarted();
    this.forcedReason = reason;
    this.currentLabel = `forcing shutdown: ${reason}`;
    this.render();
  }

  finished(result: Parameters<ShutdownProgressObserver["finished"]>[0]): void {
    this.finishedStatus = result.status;
    if (result.status === "forced") this.forcedReason = result.reason;
    this.stopTimer();
    if (this.enabled) this.clearRenderedLine();
  }

  private ensureStarted(): void {
    if (this.startedAtMs !== null) return;
    this.startedAtMs = this.now();
    if (!this.enabled) return;
    this.interval = this.setIntervalFn(() => this.render(), 1000);
  }

  private render(): void {
    if (!this.enabled || this.finishedStatus !== null || this.startedAtMs === null) return;
    const elapsedSeconds = Math.floor((this.now() - this.startedAtMs) / 1000);
    const graceSeconds = this.options.graceMs / 1000;
    const total = this.actions.size;
    const completed = [...this.actions.values()].filter((status) => status === "completed" || status === "failed").length;
    const failed = [...this.actions.values()].filter((status) => status === "failed").length;
    const pending = Math.max(0, total - completed);
    const forceSuffix = this.forcedReason ? ` force=${this.forcedReason}` : "";
    const text = `symphony shutdown ${elapsedSeconds.toFixed(0)}s/${graceSeconds.toFixed(1)}s actions=${completed}/${total} pending=${pending} failed=${failed}${forceSuffix} current=${this.currentLabel}`;
    this.clearRenderedLine();
    this.options.stream.write(`\r${this.truncate(text)}`);
  }

  private clearRenderedLine(): void {
    this.options.stream.write("\r\x1b[2K");
  }

  private stopTimer(): void {
    if (this.interval === null) return;
    this.clearIntervalFn(this.interval);
    this.interval = null;
  }

  private truncate(text: string): string {
    const columns = this.options.stream.columns;
    if (!columns || columns < 10 || text.length < columns) return text;
    return text.slice(0, columns - 1);
  }
}
