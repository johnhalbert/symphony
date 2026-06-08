import type { IssueLifecycleRecord } from "../persistence/IssueLifecycleStore.js";
import type { Issue } from "../types.js";
import type { NewWritebackOperation } from "./WritebackOutbox.js";

export interface WritebackProjectContext {
  projectContextId?: string;
  projectContextLabel?: string | null;
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
  for (const context of contexts) {
    if (projectContextId === undefined && context?.projectContextId !== undefined) {
      projectContextId = context.projectContextId;
    }
    if (projectContextLabel === undefined && context?.projectContextLabel !== undefined) {
      projectContextLabel = context.projectContextLabel;
    }
  }
  return compactProjectContext(projectContextId, projectContextLabel);
}

export function stampWritebackProjectContext<T extends NewWritebackOperation>(
  operation: T,
  context: WritebackProjectContext,
): T {
  if (context.projectContextId === undefined) return operation;
  return {
    ...operation,
    projectContextId: context.projectContextId,
    ...(context.projectContextLabel === undefined ? {} : { projectContextLabel: context.projectContextLabel }),
  } as T;
}

export function stampWritebackProjectContexts<T extends NewWritebackOperation>(
  operations: readonly T[],
  context: WritebackProjectContext,
): T[] {
  return operations.map((operation) => stampWritebackProjectContext(operation, context));
}

function compactProjectContext(
  projectContextId: string | undefined,
  projectContextLabel: string | null | undefined,
): WritebackProjectContext {
  if (projectContextId === undefined) return {};
  return {
    projectContextId,
    ...(projectContextLabel === undefined ? {} : { projectContextLabel }),
  };
}
