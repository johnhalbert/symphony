import type { ServiceConfig } from "../core/config/Config.js";
import {
  normalizeProjectContextId,
  projectContextResolutionFromIssue,
  type ProjectContextIssueLike,
  type ProjectContextResolution,
} from "../core/config/ProjectContexts.js";
import type { Logger } from "../core/logging/StructuredLogger.js";
import {
  FileIssueLifecycleStore,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
} from "../core/persistence/IssueLifecycleStore.js";
import {
  ProjectionRevisionNotifier,
  type ProjectionChangeListener,
  type ProjectionChangeSource,
  type ProjectionChangeUnsubscribe,
} from "../core/persistence/ProjectionRevision.js";
import {
  FileRunTranscriptStore,
  compareRunChronology,
  type CiStatusTranscriptInput,
  type PullRequestTranscriptInput,
  type RunRecord,
  type StartRunInput,
  type TranscriptEvent,
  type TranscriptPage,
  type UpdateRunInput,
  type WorkspaceRecord,
} from "../core/persistence/RunTranscriptStore.js";
import {
  FileOperatorApprovalStore,
  type OperatorApprovalDecision,
  type OperatorApprovalRecord,
  type OperatorApprovalRequestInput,
  type OperatorApprovalResolution,
} from "../core/approval/OperatorApprovalService.js";
import type { Issue } from "../core/types.js";
import { WorkspaceManager } from "../core/workspace/WorkspaceManager.js";
import {
  FileWritebackOutboxStore,
  type NewWritebackOperation,
  type WritebackOperation,
} from "../core/writeback/WritebackOutbox.js";

export interface ProjectContextRuntimeDependencies {
  workspaceManager: ProjectContextWorkspaceManager;
  runStore: ProjectContextRunTranscriptStore;
  lifecycleStore: ProjectContextLifecycleStore;
  writebackOutbox: ProjectContextWritebackOutboxStore;
  operatorApprovalStore: ProjectContextOperatorApprovalStore;
  updateConfig(config: ServiceConfig): void;
}

export function createProjectContextRuntimeDependencies(
  config: ServiceConfig,
  logger: Logger,
): ProjectContextRuntimeDependencies {
  const workspaceManager = new ProjectContextWorkspaceManager(config, logger);
  const runStore = new ProjectContextRunTranscriptStore(config);
  const lifecycleStore = new ProjectContextLifecycleStore(config);
  const writebackOutbox = new ProjectContextWritebackOutboxStore(config);
  const operatorApprovalStore = new ProjectContextOperatorApprovalStore(config);
  return {
    workspaceManager,
    runStore,
    lifecycleStore,
    writebackOutbox,
    operatorApprovalStore,
    updateConfig(nextConfig: ServiceConfig): void {
      workspaceManager.updateConfig(nextConfig);
      runStore.updateConfig(nextConfig);
      lifecycleStore.updateConfig(nextConfig);
      writebackOutbox.updateConfig(nextConfig);
      operatorApprovalStore.updateConfig(nextConfig);
    },
  };
}

function routedProjectContextId(config: ServiceConfig, issueLike: ProjectContextIssueLike | null | undefined): string {
  const resolution = issueLike ? projectContextResolutionFromIssue(issueLike) : undefined;
  return resolution ? normalizeProjectContextId(resolution.projectContextId) : config.projectContexts.defaultContextId;
}

function projectContextIdForResolution(config: ServiceConfig, projectContext: ProjectContextResolution | undefined): string {
  return projectContext ? normalizeProjectContextId(projectContext.projectContextId) : config.projectContexts.defaultContextId;
}

function uniqueValues<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function sortWritebackChronology(left: WritebackOperation, right: WritebackOperation): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.idempotencyKey.localeCompare(right.idempotencyKey)
  );
}

function latestPendingApproval(records: OperatorApprovalRecord[]): OperatorApprovalRecord | null {
  const pending = records.filter((record) => record.status === "pending");
  pending.sort(
    (left, right) =>
      Date.parse(left.requestedAt) - Date.parse(right.requestedAt) ||
      left.requestedAt.localeCompare(right.requestedAt) ||
      left.requestId.localeCompare(right.requestId),
  );
  return pending[pending.length - 1] ?? null;
}

function recordByNewestStartedAt(records: RunRecord[]): RunRecord | null {
  const sorted = [...records].sort(compareRunChronology);
  return sorted[sorted.length - 1] ?? null;
}

function dedupeByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    deduped.push(item);
  }
  return deduped;
}

class RoutedProjectionNotifier {
  private readonly notifier = new ProjectionRevisionNotifier();
  private readonly subscriptions = new Map<object, ProjectionChangeUnsubscribe>();

  projectionRevision(): number {
    return this.notifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.notifier.subscribe(listener);
  }

  subscribe(
    key: object,
    source: { onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe },
  ): void {
    if (this.subscriptions.has(key)) return;
    const unsubscribe = source.onProjectionChanged((event) => {
      this.notifier.notify(event.source as ProjectionChangeSource, event.detail ?? null);
    });
    this.subscriptions.set(key, unsubscribe);
  }
}

export class ProjectContextWorkspaceManager extends WorkspaceManager {
  private config: ServiceConfig;
  private readonly currentManagersByProjectContextId = new Map<string, WorkspaceManager>();
  private readonly managersByIssueKey = new Map<string, WorkspaceManager>();
  private readonly managersByWorkspacePath = new Map<string, WorkspaceManager>();
  private readonly logger: Logger;

  constructor(config: ServiceConfig, logger: Logger) {
    super({
      workspace: config.workspace,
      hooks: config.hooks,
      logger,
      planningWorkspaceMode: config.issueBreakdown.workspaceMode,
    });
    this.config = config;
    this.logger = logger;
    this.rebuildCurrentManagers(config);
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    this.rebuildCurrentManagers(config);
  }

  private rebuildCurrentManagers(config: ServiceConfig): void {
    this.currentManagersByProjectContextId.clear();
    for (const context of config.projectContexts.contexts) {
      this.currentManagersByProjectContextId.set(
        context.id,
        new WorkspaceManager({
          workspace: context.workspace,
          hooks: config.hooks,
          logger: this.logger,
          planningWorkspaceMode: context.issueBreakdown.workspaceMode,
        }),
      );
    }
  }

  private currentManagerForProjectContextId(projectContextId: string): WorkspaceManager {
    const store =
      this.currentManagersByProjectContextId.get(projectContextId) ??
      this.currentManagersByProjectContextId.get(this.config.projectContexts.defaultContextId);
    if (!store) throw new Error(`No workspace manager configured for project context ${projectContextId}`);
    return store;
  }

  private managerForIssue(issue: Issue): WorkspaceManager {
    return (
      this.managersByIssueKey.get(issue.id) ??
      this.managersByIssueKey.get(issue.identifier) ??
      this.currentManagerForProjectContextId(routedProjectContextId(this.config, issue as unknown as ProjectContextIssueLike))
    );
  }

  private allManagers(): WorkspaceManager[] {
    return uniqueValues([
      ...this.currentManagersByProjectContextId.values(),
      ...this.managersByIssueKey.values(),
      ...this.managersByWorkspacePath.values(),
    ]);
  }

  private rememberIssueManager(issue: Pick<Issue, "id" | "identifier">, manager: WorkspaceManager): void {
    this.managersByIssueKey.set(issue.id, manager);
    this.managersByIssueKey.set(issue.identifier, manager);
  }

  private rememberWorkspaceManager(workspacePath: string, manager: WorkspaceManager): void {
    this.managersByWorkspacePath.set(workspacePath, manager);
  }

  private managerForWorkspacePath(workspacePath: string): WorkspaceManager | null {
    const known = this.managersByWorkspacePath.get(workspacePath);
    if (known) return known;
    const manager = this.allManagers().find((candidate) => candidate.isInsideRoot(workspacePath)) ?? null;
    if (manager) this.rememberWorkspaceManager(workspacePath, manager);
    return manager;
  }

  override async createForIssue(issue: Issue) {
    const manager = this.managerForIssue(issue);
    this.rememberIssueManager(issue, manager);
    const workspace = await manager.createForIssue(issue);
    this.rememberWorkspaceManager(workspace.path, manager);
    return workspace;
  }

  override async createForPlanning(issue: Issue) {
    const manager = this.managerForIssue(issue);
    this.rememberIssueManager(issue, manager);
    const workspace = await manager.createForPlanning(issue);
    this.rememberWorkspaceManager(workspace.path, manager);
    return workspace;
  }

  override async beforeRun(workspacePath: string): Promise<void> {
    const manager = this.managerForWorkspacePath(workspacePath);
    if (manager) await manager.beforeRun(workspacePath);
  }

  override async afterRun(workspacePath: string): Promise<void> {
    const manager = this.managerForWorkspacePath(workspacePath);
    if (manager) await manager.afterRun(workspacePath);
  }

  override async removeForIssue(issue: Issue): Promise<void> {
    const manager = this.managerForIssue(issue);
    await manager.removeForIssue(issue);
  }

  override async removeForPlanning(issue: Issue): Promise<void> {
    const manager = this.managerForIssue(issue);
    await manager.removeForPlanning(issue);
  }

  override getPathForIssue(issueIdentifier: string): string {
    const manager = this.managersByIssueKey.get(issueIdentifier) ?? this.currentManagerForProjectContextId(this.config.projectContexts.defaultContextId);
    return manager.getPathForIssue(issueIdentifier);
  }

  override async getWorkspaceRecord(workspaceKeyOrIssue: string): Promise<WorkspaceRecord | null> {
    for (const manager of this.allManagers()) {
      const record = await manager.getWorkspaceRecord(workspaceKeyOrIssue);
      if (!record) continue;
      this.rememberWorkspaceManager(record.path, manager);
      if (record.issueId) {
        this.managersByIssueKey.set(record.issueId, manager);
      }
      this.managersByIssueKey.set(record.issueIdentifier, manager);
      return record;
    }
    return null;
  }

  override isInsideRoot(workspacePath: string): boolean {
    return this.allManagers().some((manager) => manager.isInsideRoot(workspacePath));
  }
}

export class ProjectContextLifecycleStore extends FileIssueLifecycleStore {
  private config: ServiceConfig;
  private readonly currentStoresByProjectContextId = new Map<string, FileIssueLifecycleStore>();
  private readonly storesByIssueKey = new Map<string, FileIssueLifecycleStore>();
  private readonly projections = new RoutedProjectionNotifier();

  constructor(config: ServiceConfig) {
    super(config.workspace.stateDir);
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  override projectionRevision(): number {
    return this.projections.projectionRevision();
  }

  override onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projections.onProjectionChanged(listener);
  }

  private rebuildCurrentStores(config: ServiceConfig): void {
    this.currentStoresByProjectContextId.clear();
    for (const context of config.projectContexts.contexts) {
      const store = new FileIssueLifecycleStore(context.workspace.stateDir);
      this.currentStoresByProjectContextId.set(context.id, store);
      this.projections.subscribe(store, store);
    }
  }

  private currentStoreForProjectContextId(projectContextId: string): FileIssueLifecycleStore {
    const store =
      this.currentStoresByProjectContextId.get(projectContextId) ??
      this.currentStoresByProjectContextId.get(this.config.projectContexts.defaultContextId);
    if (!store) throw new Error(`No lifecycle store configured for project context ${projectContextId}`);
    return store;
  }

  private candidateStores(): FileIssueLifecycleStore[] {
    return uniqueValues([...this.currentStoresByProjectContextId.values(), ...this.storesByIssueKey.values()]);
  }

  private rememberIssueStore(issue: Pick<Issue, "id" | "identifier">, store: FileIssueLifecycleStore): void {
    this.storesByIssueKey.set(issue.id, store);
    this.storesByIssueKey.set(issue.identifier, store);
    this.projections.subscribe(store, store);
  }

  private storeForIssue(issue: Pick<Issue, "id" | "identifier">): FileIssueLifecycleStore {
    return (
      this.storesByIssueKey.get(issue.id) ??
      this.storesByIssueKey.get(issue.identifier) ??
      this.currentStoreForProjectContextId(routedProjectContextId(this.config, issue as unknown as ProjectContextIssueLike))
    );
  }

  override async ensureIssue(
    issue: Pick<Issue, "id" | "identifier">,
    patch: IssueLifecyclePatch = {},
  ): Promise<IssueLifecycleRecord> {
    const store = this.storeForIssue(issue);
    this.rememberIssueStore(issue, store);
    return store.ensureIssue(issue, patch);
  }

  override async updateIssue(
    issue: Pick<Issue, "id" | "identifier">,
    patch: IssueLifecyclePatch,
  ): Promise<IssueLifecycleRecord> {
    const store = this.storeForIssue(issue);
    this.rememberIssueStore(issue, store);
    return store.updateIssue(issue, patch);
  }

  override async get(issueIdOrIdentifier: string): Promise<IssueLifecycleRecord | null> {
    const knownStore = this.storesByIssueKey.get(issueIdOrIdentifier);
    if (knownStore) return knownStore.get(issueIdOrIdentifier);
    for (const store of this.candidateStores()) {
      const record = await store.get(issueIdOrIdentifier);
      if (!record) continue;
      this.rememberIssueStore({ id: record.issueId, identifier: record.issueIdentifier }, store);
      return record;
    }
    return null;
  }

  override async list(): Promise<IssueLifecycleRecord[]> {
    const records = (await Promise.all(this.candidateStores().map((store) => store.list()))).flat();
    return dedupeByKey(records, (record) => record.issueId);
  }
}

export class ProjectContextRunTranscriptStore extends FileRunTranscriptStore {
  private config: ServiceConfig;
  private readonly currentStoresByProjectContextId = new Map<string, FileRunTranscriptStore>();
  private readonly storesByIssueKey = new Map<string, FileRunTranscriptStore>();
  private readonly storesByRunId = new Map<string, FileRunTranscriptStore>();
  private readonly storesByWorkspaceKey = new Map<string, FileRunTranscriptStore>();
  private readonly projections = new RoutedProjectionNotifier();

  constructor(config: ServiceConfig) {
    super(config.workspace.stateDir);
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  override projectionRevision(): number {
    return this.projections.projectionRevision();
  }

  override onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projections.onProjectionChanged(listener);
  }

  private rebuildCurrentStores(config: ServiceConfig): void {
    this.currentStoresByProjectContextId.clear();
    for (const context of config.projectContexts.contexts) {
      const store = new FileRunTranscriptStore(context.workspace.stateDir);
      this.currentStoresByProjectContextId.set(context.id, store);
      this.projections.subscribe(store, store);
    }
  }

  private currentStoreForProjectContextId(projectContextId: string): FileRunTranscriptStore {
    const store =
      this.currentStoresByProjectContextId.get(projectContextId) ??
      this.currentStoresByProjectContextId.get(this.config.projectContexts.defaultContextId);
    if (!store) throw new Error(`No run store configured for project context ${projectContextId}`);
    return store;
  }

  private candidateStores(): FileRunTranscriptStore[] {
    return uniqueValues([
      ...this.currentStoresByProjectContextId.values(),
      ...this.storesByIssueKey.values(),
      ...this.storesByRunId.values(),
      ...this.storesByWorkspaceKey.values(),
    ]);
  }

  private rememberIssueStore(issueId: string | null, issueIdentifier: string, store: FileRunTranscriptStore): void {
    if (issueId) this.storesByIssueKey.set(issueId, store);
    this.storesByIssueKey.set(issueIdentifier, store);
    this.projections.subscribe(store, store);
  }

  private rememberRunStore(runId: string, store: FileRunTranscriptStore): void {
    this.storesByRunId.set(runId, store);
    this.projections.subscribe(store, store);
  }

  private rememberWorkspaceStore(workspaceKey: string, store: FileRunTranscriptStore): void {
    this.storesByWorkspaceKey.set(workspaceKey, store);
    this.projections.subscribe(store, store);
  }

  private storeForIssueRouting(
    issueId: string | null,
    issueIdentifier: string,
    projectContext: StartRunInput["projectContext"],
  ): FileRunTranscriptStore {
    return (
      (issueId ? this.storesByIssueKey.get(issueId) : undefined) ??
      this.storesByIssueKey.get(issueIdentifier) ??
      this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, projectContext))
    );
  }

  private async storeForRun(runId: string): Promise<FileRunTranscriptStore | null> {
    const knownStore = this.storesByRunId.get(runId);
    if (knownStore) return knownStore;
    for (const store of this.candidateStores()) {
      const record = await store.getRun(runId);
      if (!record) continue;
      this.rememberRunStore(runId, store);
      this.rememberIssueStore(record.issueId, record.issueIdentifier, store);
      return store;
    }
    return null;
  }

  override async upsertWorkspace(record: WorkspaceRecord): Promise<void> {
    const store =
      this.storesByWorkspaceKey.get(record.workspaceKey) ??
      this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, record.projectContext));
    await store.upsertWorkspace(record);
    this.rememberWorkspaceStore(record.workspaceKey, store);
    if (record.issueId) this.rememberIssueStore(record.issueId, record.issueIdentifier, store);
  }

  override async getWorkspace(workspaceKey: string): Promise<WorkspaceRecord | null> {
    const knownStore = this.storesByWorkspaceKey.get(workspaceKey);
    if (knownStore) return knownStore.getWorkspace(workspaceKey);
    for (const store of this.candidateStores()) {
      const record = await store.getWorkspace(workspaceKey);
      if (!record) continue;
      this.rememberWorkspaceStore(record.workspaceKey, store);
      if (record.issueId) this.rememberIssueStore(record.issueId, record.issueIdentifier, store);
      return record;
    }
    return null;
  }

  override async deleteWorkspace(workspaceKey: string): Promise<void> {
    const knownStore = this.storesByWorkspaceKey.get(workspaceKey);
    if (knownStore) {
      await knownStore.deleteWorkspace(workspaceKey);
      return;
    }
    for (const store of this.candidateStores()) {
      const record = await store.getWorkspace(workspaceKey);
      if (!record) continue;
      this.rememberWorkspaceStore(record.workspaceKey, store);
      await store.deleteWorkspace(workspaceKey);
      return;
    }
  }

  override async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const records = (await Promise.all(this.candidateStores().map((store) => store.listWorkspaces()))).flat();
    for (const record of records) {
      this.rememberWorkspaceStore(record.workspaceKey, this.storesByWorkspaceKey.get(record.workspaceKey) ?? this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, record.projectContext)));
    }
    return dedupeByKey(records, (record) => record.workspaceKey);
  }

  override async findWorkspace(issueIdOrIdentifierOrKey: string): Promise<WorkspaceRecord | null> {
    const knownStore =
      this.storesByWorkspaceKey.get(issueIdOrIdentifierOrKey) ?? this.storesByIssueKey.get(issueIdOrIdentifierOrKey);
    if (knownStore) return knownStore.findWorkspace(issueIdOrIdentifierOrKey);
    for (const store of this.candidateStores()) {
      const record = await store.findWorkspace(issueIdOrIdentifierOrKey);
      if (!record) continue;
      this.rememberWorkspaceStore(record.workspaceKey, store);
      if (record.issueId) this.rememberIssueStore(record.issueId, record.issueIdentifier, store);
      return record;
    }
    return null;
  }

  override async startRun(input: StartRunInput): Promise<RunRecord> {
    const store = this.storeForIssueRouting(input.issueId, input.issueIdentifier, input.projectContext);
    this.rememberRunStore(input.runId, store);
    this.rememberIssueStore(input.issueId, input.issueIdentifier, store);
    return store.startRun(input);
  }

  override async updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord | null> {
    const store = await this.storeForRun(runId);
    if (!store) return null;
    return store.updateRun(runId, patch);
  }

  override async recordPullRequestEvent(input: PullRequestTranscriptInput): Promise<TranscriptEvent | null> {
    const store = await this.storeForRun(input.runId);
    if (!store) return null;
    return store.recordPullRequestEvent(input);
  }

  override async recordCiStatusEvent(input: CiStatusTranscriptInput): Promise<TranscriptEvent | null> {
    const store = await this.storeForRun(input.runId);
    if (!store) return null;
    return store.recordCiStatusEvent(input);
  }

  override async appendEvent(input: Omit<TranscriptEvent, "sequence"> & { sequence?: number }): Promise<TranscriptEvent> {
    const store = await this.storeForRun(input.runId);
    if (!store) throw new Error(`Run transcript store not found for ${input.runId}`);
    return store.appendEvent(input);
  }

  override async rebuildRunFromTranscript(runId: string): Promise<RunRecord | null> {
    const store = await this.storeForRun(runId);
    return store ? store.rebuildRunFromTranscript(runId) : null;
  }

  override async getRun(runId: string): Promise<RunRecord | null> {
    const store = await this.storeForRun(runId);
    return store ? store.getRun(runId) : null;
  }

  override async listRunsForIssue(issueIdOrIdentifier: string): Promise<RunRecord[]> {
    const knownStore = this.storesByIssueKey.get(issueIdOrIdentifier);
    if (knownStore) return knownStore.listRunsForIssue(issueIdOrIdentifier);
    const records = (await Promise.all(this.candidateStores().map((store) => store.listRunsForIssue(issueIdOrIdentifier)))).flat();
    const deduped = dedupeByKey(records, (record) => record.runId).sort(compareRunChronology);
    for (const record of deduped) {
      const store = this.candidateStores().find((candidate) => this.storesByRunId.get(record.runId) === candidate) ?? null;
      if (store) {
        this.rememberRunStore(record.runId, store);
        this.rememberIssueStore(record.issueId, record.issueIdentifier, store);
      }
    }
    return deduped;
  }

  override async latestRunForIssue(
    issueIdOrIdentifier: string,
    options: { role?: RunRecord["role"]; runPhase?: RunRecord["runPhase"]; runKind?: RunRecord["runKind"] } = {},
  ): Promise<RunRecord | null> {
    const knownStore = this.storesByIssueKey.get(issueIdOrIdentifier);
    const latestOptions = {
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.runPhase === undefined ? {} : { runPhase: options.runPhase }),
      ...(options.runKind === undefined ? {} : { runKind: options.runKind }),
    };
    if (knownStore) return knownStore.latestRunForIssue(issueIdOrIdentifier, latestOptions);
    const records = (
      await Promise.all(this.candidateStores().map((store) => store.latestRunForIssue(issueIdOrIdentifier, latestOptions)))
    ).filter((record): record is RunRecord => record !== null);
    return recordByNewestStartedAt(records);
  }

  override async readTranscript(runId: string, options: { offset?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const store = await this.storeForRun(runId);
    if (!store) throw new Error(`Run transcript store not found for ${runId}`);
    return store.readTranscript(runId, options);
  }

  override async readTranscriptTail(runId: string, options: { limit?: number } = {}): Promise<TranscriptPage> {
    const store = await this.storeForRun(runId);
    if (!store) throw new Error(`Run transcript store not found for ${runId}`);
    return store.readTranscriptTail(runId, options);
  }

  override async readTranscriptEventCount(runId: string): Promise<number> {
    const store = await this.storeForRun(runId);
    return store ? store.readTranscriptEventCount(runId) : 0;
  }

  override async ensureTranscriptEventCount(runId: string): Promise<number> {
    const store = await this.storeForRun(runId);
    return store ? store.ensureTranscriptEventCount(runId) : 0;
  }

  override async listRuns(): Promise<RunRecord[]> {
    const records = (await Promise.all(this.candidateStores().map((store) => store.listRuns()))).flat();
    return dedupeByKey(records, (record) => record.runId).sort(compareRunChronology);
  }
}

export class ProjectContextWritebackOutboxStore extends FileWritebackOutboxStore {
  private config: ServiceConfig;
  private readonly currentStoresByProjectContextId = new Map<string, FileWritebackOutboxStore>();
  private readonly storesByIdempotencyKey = new Map<string, FileWritebackOutboxStore>();
  private readonly storesByIssueKey = new Map<string, FileWritebackOutboxStore>();
  private readonly storesByRunId = new Map<string, FileWritebackOutboxStore>();
  private readonly projections = new RoutedProjectionNotifier();

  constructor(config: ServiceConfig) {
    super(config.workspace.stateDir);
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  override projectionRevision(): number {
    return this.projections.projectionRevision();
  }

  override onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projections.onProjectionChanged(listener);
  }

  private rebuildCurrentStores(config: ServiceConfig): void {
    this.currentStoresByProjectContextId.clear();
    for (const context of config.projectContexts.contexts) {
      const store = new FileWritebackOutboxStore(context.workspace.stateDir);
      this.currentStoresByProjectContextId.set(context.id, store);
      this.projections.subscribe(store, store);
    }
  }

  private currentStoreForProjectContextId(projectContextId: string): FileWritebackOutboxStore {
    const store =
      this.currentStoresByProjectContextId.get(projectContextId) ??
      this.currentStoresByProjectContextId.get(this.config.projectContexts.defaultContextId);
    if (!store) throw new Error(`No writeback outbox configured for project context ${projectContextId}`);
    return store;
  }

  private candidateStores(): FileWritebackOutboxStore[] {
    return uniqueValues([
      ...this.currentStoresByProjectContextId.values(),
      ...this.storesByIdempotencyKey.values(),
      ...this.storesByIssueKey.values(),
      ...this.storesByRunId.values(),
    ]);
  }

  private rememberStore(record: Pick<WritebackOperation, "idempotencyKey" | "issueId" | "runId">, store: FileWritebackOutboxStore): void {
    this.storesByIdempotencyKey.set(record.idempotencyKey, store);
    this.storesByIssueKey.set(record.issueId, store);
    if (record.runId) this.storesByRunId.set(record.runId, store);
    this.projections.subscribe(store, store);
  }

  private storeForOperation(operation: Pick<NewWritebackOperation, "idempotencyKey" | "issueId" | "runId" | "projectContext">): FileWritebackOutboxStore {
    return (
      this.storesByIdempotencyKey.get(operation.idempotencyKey) ??
      (operation.runId ? this.storesByRunId.get(operation.runId) : undefined) ??
      this.storesByIssueKey.get(operation.issueId) ??
      this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, operation.projectContext))
    );
  }

  private async storeForRecord(idempotencyKey: string): Promise<FileWritebackOutboxStore | null> {
    const knownStore = this.storesByIdempotencyKey.get(idempotencyKey);
    if (knownStore) return knownStore;
    for (const store of this.candidateStores()) {
      const record = await store.get(idempotencyKey);
      if (!record) continue;
      this.rememberStore(record, store);
      return store;
    }
    return null;
  }

  override async enqueueOnce(operation: NewWritebackOperation): Promise<WritebackOperation> {
    const store = this.storeForOperation(operation);
    const record = await store.enqueueOnce(operation);
    this.rememberStore(record, store);
    return record;
  }

  override async claimDue(
    now = new Date(),
    options: { idempotencyKeys?: readonly string[] } = {},
  ): Promise<WritebackOperation[]> {
    const claimed = (await Promise.all(this.candidateStores().map((store) => store.claimDue(now, options)))).flat();
    for (const record of claimed) {
      const store =
        this.storesByIdempotencyKey.get(record.idempotencyKey) ??
        (record.runId ? this.storesByRunId.get(record.runId) : undefined) ??
        this.storesByIssueKey.get(record.issueId) ??
        this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, record.projectContext));
      this.rememberStore(record, store);
    }
    return dedupeByKey(claimed, (record) => record.idempotencyKey).sort(sortWritebackChronology);
  }

  override async markSucceeded(record: WritebackOperation, result?: Parameters<FileWritebackOutboxStore["markSucceeded"]>[1]): Promise<WritebackOperation> {
    const store = (await this.storeForRecord(record.idempotencyKey)) ?? this.storeForOperation(record);
    const updated = await store.markSucceeded(record, result);
    this.rememberStore(updated, store);
    return updated;
  }

  override async markSkipped(
    record: WritebackOperation,
    message: string,
    result?: Parameters<FileWritebackOutboxStore["markSkipped"]>[2],
  ): Promise<WritebackOperation> {
    const store = (await this.storeForRecord(record.idempotencyKey)) ?? this.storeForOperation(record);
    const updated = await store.markSkipped(record, message, result);
    this.rememberStore(updated, store);
    return updated;
  }

  override async requeueSkipped(record: WritebackOperation): Promise<WritebackOperation> {
    const store = (await this.storeForRecord(record.idempotencyKey)) ?? this.storeForOperation(record);
    const updated = await store.requeueSkipped(record);
    this.rememberStore(updated, store);
    return updated;
  }

  override async markRetry(record: WritebackOperation, error: string, nextAttemptAt: string): Promise<WritebackOperation> {
    const store = (await this.storeForRecord(record.idempotencyKey)) ?? this.storeForOperation(record);
    const updated = await store.markRetry(record, error, nextAttemptAt);
    this.rememberStore(updated, store);
    return updated;
  }

  override async markDeadLetter(record: WritebackOperation, error: string): Promise<WritebackOperation> {
    const store = (await this.storeForRecord(record.idempotencyKey)) ?? this.storeForOperation(record);
    const updated = await store.markDeadLetter(record, error);
    this.rememberStore(updated, store);
    return updated;
  }

  override async get(idempotencyKey: string): Promise<WritebackOperation | null> {
    const store = await this.storeForRecord(idempotencyKey);
    return store ? store.get(idempotencyKey) : null;
  }

  override async list(): Promise<WritebackOperation[]> {
    const records = (await Promise.all(this.candidateStores().map((store) => store.list()))).flat();
    return dedupeByKey(records, (record) => record.idempotencyKey).sort(sortWritebackChronology);
  }
}

export class ProjectContextOperatorApprovalStore extends FileOperatorApprovalStore {
  private config: ServiceConfig;
  private readonly currentStoresByProjectContextId = new Map<string, FileOperatorApprovalStore>();
  private readonly storesByRequestId = new Map<string, FileOperatorApprovalStore>();
  private readonly storesByRunId = new Map<string, FileOperatorApprovalStore>();
  private readonly storesByIssueKey = new Map<string, FileOperatorApprovalStore>();

  constructor(config: ServiceConfig) {
    super(config.workspace.stateDir);
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    this.rebuildCurrentStores(config);
  }

  private rebuildCurrentStores(config: ServiceConfig): void {
    this.currentStoresByProjectContextId.clear();
    for (const context of config.projectContexts.contexts) {
      this.currentStoresByProjectContextId.set(context.id, new FileOperatorApprovalStore(context.workspace.stateDir));
    }
  }

  private currentStoreForProjectContextId(projectContextId: string): FileOperatorApprovalStore {
    const store =
      this.currentStoresByProjectContextId.get(projectContextId) ??
      this.currentStoresByProjectContextId.get(this.config.projectContexts.defaultContextId);
    if (!store) throw new Error(`No operator approval store configured for project context ${projectContextId}`);
    return store;
  }

  private candidateStores(): FileOperatorApprovalStore[] {
    return uniqueValues([
      ...this.currentStoresByProjectContextId.values(),
      ...this.storesByRequestId.values(),
      ...this.storesByRunId.values(),
      ...this.storesByIssueKey.values(),
    ]);
  }

  private rememberStore(record: Pick<OperatorApprovalRecord, "requestId" | "runId" | "issueId" | "issueIdentifier">, store: FileOperatorApprovalStore): void {
    this.storesByRequestId.set(record.requestId, store);
    this.storesByRunId.set(record.runId, store);
    this.storesByIssueKey.set(record.issueId, store);
    this.storesByIssueKey.set(record.issueIdentifier, store);
  }

  private storeForRequestInput(input: OperatorApprovalRequestInput): FileOperatorApprovalStore {
    return (
      this.storesByRunId.get(input.runId) ??
      this.storesByIssueKey.get(input.issueId) ??
      this.storesByIssueKey.get(input.issueIdentifier) ??
      this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, input.projectContext))
    );
  }

  private async storeForRequestId(requestId: string): Promise<FileOperatorApprovalStore | null> {
    const knownStore = this.storesByRequestId.get(requestId);
    if (knownStore) return knownStore;
    for (const store of this.candidateStores()) {
      const record = await store.get(requestId);
      if (!record) continue;
      this.rememberStore(record, store);
      return store;
    }
    return null;
  }

  override async requestOrGetPending(
    input: OperatorApprovalRequestInput,
    timeoutMs: number | null,
  ): Promise<{ record: OperatorApprovalRecord; created: boolean }> {
    const store = this.storeForRequestInput(input);
    const result = await store.requestOrGetPending(input, timeoutMs);
    this.rememberStore(result.record, store);
    return result;
  }

  override async get(requestId: string): Promise<OperatorApprovalRecord | null> {
    const store = await this.storeForRequestId(requestId);
    return store ? store.get(requestId) : null;
  }

  override async getByDedupe(runId: string, evidenceCursor: string): Promise<OperatorApprovalRecord | null> {
    const knownStore = this.storesByRunId.get(runId);
    if (knownStore) return knownStore.getByDedupe(runId, evidenceCursor);
    for (const store of this.candidateStores()) {
      const record = await store.getByDedupe(runId, evidenceCursor);
      if (!record) continue;
      this.rememberStore(record, store);
      return record;
    }
    return null;
  }

  override async findPendingForRun(runId: string): Promise<OperatorApprovalRecord | null> {
    const knownStore = this.storesByRunId.get(runId);
    if (knownStore) return knownStore.findPendingForRun(runId);
    for (const store of this.candidateStores()) {
      const record = await store.findPendingForRun(runId);
      if (!record) continue;
      this.rememberStore(record, store);
      return record;
    }
    return null;
  }

  override async findPendingForIssue(
    keys: string[],
    projectContext: ProjectContextResolution | undefined = undefined,
  ): Promise<OperatorApprovalRecord | null> {
    const candidates: OperatorApprovalRecord[] = [];
    const preferredStore = projectContext
      ? this.currentStoreForProjectContextId(projectContextIdForResolution(this.config, projectContext))
      : null;
    if (preferredStore) {
      const preferred = await preferredStore.findPendingForIssue(keys, projectContext);
      if (preferred) candidates.push(preferred);
    }
    for (const store of this.candidateStores()) {
      if (store === preferredStore) continue;
      const record = await store.findPendingForIssue(keys, projectContext);
      if (record) candidates.push(record);
    }
    return latestPendingApproval(candidates);
  }

  override async list(): Promise<OperatorApprovalRecord[]> {
    const records = (await Promise.all(this.candidateStores().map((store) => store.list()))).flat();
    return dedupeByKey(records, (record) => record.requestId);
  }

  override async resolve(requestId: string, decision: OperatorApprovalDecision): Promise<OperatorApprovalResolution> {
    const store = await this.storeForRequestId(requestId);
    if (!store) return super.resolve(requestId, decision);
    const result = await store.resolve(requestId, decision);
    this.rememberStore(result.request, store);
    return result;
  }

  override async markStale(requestId: string, reason: string): Promise<OperatorApprovalRecord> {
    const store = await this.storeForRequestId(requestId);
    if (!store) return super.markStale(requestId, reason);
    const result = await store.markStale(requestId, reason);
    this.rememberStore(result, store);
    return result;
  }

  override async markExpired(requestId: string): Promise<OperatorApprovalRecord> {
    const store = await this.storeForRequestId(requestId);
    if (!store) return super.markExpired(requestId);
    const result = await store.markExpired(requestId);
    this.rememberStore(result, store);
    return result;
  }

  override async markCancelled(requestId: string, reason: string): Promise<OperatorApprovalRecord> {
    const store = await this.storeForRequestId(requestId);
    if (!store) return super.markCancelled(requestId, reason);
    const result = await store.markCancelled(requestId, reason);
    this.rememberStore(result, store);
    return result;
  }
}
