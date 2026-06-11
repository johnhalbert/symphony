import { DEFAULT_PROJECT_CONTEXT_ID, normalizeProjectContextResolution, type ProjectContextResolution } from "../config/ProjectContexts.js";
import type { IssueLifecycleRecord } from "../persistence/IssueLifecycleStore.js";
import type { Issue } from "../types.js";
import type { NewWritebackOperation } from "./WritebackOutbox.js";

export interface WritebackProjectContext {
  projectContextId?: string;
  projectContextLabel?: string | null;
  projectContext?: ProjectContextResolution | null;
}

export function writebackProjectContextFromIssue(
  issue: Pick<Issue, "projectContextId" | "projectContextLabel"> | null | undefined,
): WritebackProjectContext {
  return compactProjectContext(issue?.projectContextId, issue?.projectContextLabel);
}

export function writebackProjectContextFromLifecycle(
  lifecycle: Pick<IssueLifecycleRecord, "projectContextId" | "projectContextLabel" | "summaryPointers"> | null | undefined,
): WritebackProjectContext {
  return compactProjectContext(
    lifecycle?.projectContextId ?? lifecycle?.summaryPointers.projectContextId,
    lifecycle?.projectContextLabel ?? lifecycle?.summaryPointers.projectContextLabel,
  );
}

export function mergeWritebackProjectContexts(
  ...contexts: Array<WritebackProjectContext | null | undefined>
): WritebackProjectContext {
  let projectContextId: string | undefined;
  let projectContextLabel: string | null | undefined;
  let projectContext: ProjectContextResolution | null | undefined;
  for (const context of contexts) {
    if (projectContextId === undefined && context?.projectContextId !== undefined) {
      projectContextId = context.projectContextId;
    }
    if (projectContextLabel === undefined && context?.projectContextLabel !== undefined) {
      projectContextLabel = context.projectContextLabel;
    }
    if (projectContext === undefined && context?.projectContext !== undefined) {
      projectContext = context.projectContext;
    }
  }
  return compactProjectContext(projectContextId, projectContextLabel, projectContext);
}

export function stampWritebackProjectContext<T extends NewWritebackOperation>(
  operation: T,
  context: WritebackProjectContext,
): T {
  if (context.projectContextId === undefined) return operation;
  return {
    ...operation,
    idempotencyKey: scopeWritebackIdempotencyKey(operation.idempotencyKey, context.projectContextId),
    projectContextId: context.projectContextId,
    ...(context.projectContextLabel === undefined ? {} : { projectContextLabel: context.projectContextLabel }),
    ...(context.projectContext === undefined ? {} : { projectContext: context.projectContext }),
  } as T;
}

export function stampWritebackProjectContexts<T extends NewWritebackOperation>(
  operations: readonly T[],
  context: WritebackProjectContext,
): T[] {
  return operations.map((operation) => stampWritebackProjectContext(operation, context));
}

function scopeWritebackIdempotencyKey(idempotencyKey: string, projectContextId: string): string {
  if (projectContextId === DEFAULT_PROJECT_CONTEXT_ID) return idempotencyKey;
  const prefix = `project-context:${projectContextId}:`;
  return idempotencyKey.startsWith(prefix) ? idempotencyKey : `${prefix}${idempotencyKey}`;
}

function compactProjectContext(
  projectContextId: string | undefined,
  projectContextLabel: string | null | undefined,
  projectContext?: ProjectContextResolution | null,
): WritebackProjectContext {
  if (projectContextId === undefined && projectContext === undefined) return {};
  const normalized =
    projectContext ??
    (projectContextId === undefined
      ? null
      : normalizeProjectContextResolution({
          projectContextId,
          ...(projectContextLabel === undefined || projectContextLabel === null ? {} : { projectContextLabel }),
        }));
  return {
    ...(projectContextId === undefined ? {} : { projectContextId }),
    ...(projectContextLabel === undefined ? {} : { projectContextLabel }),
    ...(normalized === null ? {} : { projectContext: normalized }),
  };
}
