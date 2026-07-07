import { errorMessage } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";

export interface ShutdownProgressAction {
  id: string;
  label: string;
  component?: string;
  fields?: Record<string, unknown>;
}

export interface ShutdownProgressObserver {
  started(action: ShutdownProgressAction): void;
  completed(action: ShutdownProgressAction): void;
  failed(action: ShutdownProgressAction, error: unknown): void;
  waiting(action: ShutdownProgressAction): void;
  forced(reason: string, fields?: Record<string, unknown>): void;
  finished(result: { status: "graceful" } | { status: "forced"; reason: string } | { status: "failed"; error: unknown }): void;
}

export interface ShutdownActionOptions<T> {
  logger: Logger;
  progress?: ShutdownProgressObserver | undefined;
  action: ShutdownProgressAction;
  run: () => Promise<T> | T;
  swallowError?: boolean;
}

export async function runShutdownAction<T>({
  logger,
  progress,
  action,
  run,
  swallowError = false,
}: ShutdownActionOptions<T>): Promise<T | undefined> {
  logger.info("shutdown action started", shutdownActionLogFields(action));
  progress?.started(action);
  try {
    const result = await run();
    logger.info("shutdown action completed", shutdownActionLogFields(action));
    progress?.completed(action);
    return result;
  } catch (error) {
    logger.warn("shutdown action failed", {
      ...shutdownActionLogFields(action),
      error: errorMessage(error),
    });
    progress?.failed(action, error);
    if (swallowError) return undefined;
    throw error;
  }
}

export function shutdownActionLogFields(action: ShutdownProgressAction): Record<string, unknown> {
  return {
    action_id: action.id,
    label: action.label,
    ...(action.component === undefined ? {} : { component: action.component }),
    ...(action.fields ?? {}),
  };
}
