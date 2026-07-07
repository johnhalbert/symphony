import { errorMessage } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { ShutdownProgressObserver } from "./ShutdownProgress.js";

export type ShutdownRequestReason = "stdin_ctrl_c" | "sigint" | "sigterm" | "api";
export type ShutdownForceReason = "repeated_interrupt" | "grace_timeout" | "graceful_shutdown_failed";

export interface ShutdownCoordinatorOptions {
  logger: Logger;
  progress?: ShutdownProgressObserver | undefined;
  graceMs: number;
  shutdown: (progress?: ShutdownProgressObserver) => Promise<void>;
  forceDispose?: (reason: string) => void;
  exit?: (code: number) => void;
  setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
}

export class ShutdownCoordinator {
  private state: "idle" | "graceful" | "forced" | "finished" = "idle";
  private timer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: ShutdownCoordinatorOptions) {}

  request(reason: ShutdownRequestReason): void {
    if (this.state === "idle") {
      this.startGraceful(reason);
      return;
    }
    if (this.state === "graceful") {
      this.forceExit("repeated_interrupt");
    }
  }

  private startGraceful(reason: ShutdownRequestReason): void {
    this.state = "graceful";
    const graceMs = Math.max(0, this.options.graceMs);
    this.options.logger.info("symphony shutting down", { reason, grace_ms: graceMs });
    this.options.progress?.waiting({
      id: "shutdown.grace_wait",
      label: graceMs === 0 ? "forcing shutdown after graceful path starts" : `waiting ${graceMs / 1000}s for graceful shutdown`,
      component: "shutdown",
      fields: { grace_ms: graceMs },
    });

    this.shutdownPromise = Promise.resolve()
      .then(() => this.options.shutdown(this.options.progress))
      .then(() => this.completeGraceful())
      .catch((error: unknown) => this.failGraceful(error));

    if (graceMs === 0) {
      this.forceExit("grace_timeout");
      return;
    }

    this.timer = (this.options.setTimeout ?? setTimeout)(() => {
      this.forceExit("grace_timeout");
    }, graceMs);
    this.timer.unref?.();
  }

  private completeGraceful(): void {
    if (this.state !== "graceful") return;
    this.clearGraceTimer();
    this.state = "finished";
    this.options.logger.info("symphony shutdown completed");
    this.options.progress?.finished({ status: "graceful" });
    this.exit(0);
  }

  private failGraceful(error: unknown): void {
    if (this.state !== "graceful") return;
    this.clearGraceTimer();
    this.state = "finished";
    this.options.logger.error("symphony shutdown failed", { error: errorMessage(error) });
    this.options.progress?.finished({ status: "failed", error });
    this.exit(1);
  }

  private forceExit(reason: ShutdownForceReason): void {
    if (this.state === "forced" || this.state === "finished") return;
    this.clearGraceTimer();
    this.state = "forced";
    this.options.logger.warn("symphony forcing shutdown", { reason });
    try {
      this.options.forceDispose?.(reason);
    } catch (error) {
      this.options.logger.warn("symphony force-dispose failed", { reason, error: errorMessage(error) });
    }
    this.options.progress?.forced(reason);
    this.options.progress?.finished({ status: "forced", reason });
    this.exit(130);
  }

  private clearGraceTimer(): void {
    if (!this.timer) return;
    (this.options.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private exit(code: number): void {
    (this.options.exit ?? process.exit)(code);
  }
}
