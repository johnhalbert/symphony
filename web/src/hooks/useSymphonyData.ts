import { useCallback, useEffect, useRef, useState } from "react";
import { useDataSource } from "../data/dataSourceContext";
import { normalizeOrchestratorChatModel } from "../data/orchestratorChat";
import type { RealtimeOrchestratorMessagePayload } from "../data/realtimeEvents";
import { useAsyncResource } from "./useAsyncResource";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  applyOrchestratorMessageEvent,
  applyTranscriptDeltaEvent,
} from "../data/realtimePatches";
import type {
  ChatMessage,
  IssueDetailModel,
  Loadable,
  OrchestratorChatModel,
  TranscriptActiveTailModel,
  TranscriptMessage,
  TranscriptWindowModel,
  TranscriptWindowPageModel,
} from "../types/symphony";

interface SymphonyResourceOptions {
  enabled?: boolean;
  refreshToken?: unknown;
}

export function useReferenceData(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback((signal?: AbortSignal) => dataSource.getReferenceData(signal), [dataSource]),
    [dataSource, options.refreshToken],
    options,
  );
}

export function useDashboard(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback((signal?: AbortSignal) => dataSource.getDashboard(signal), [dataSource]),
    [dataSource, options.refreshToken],
    options,
  );
}

export function useIssueBoard(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback((signal?: AbortSignal) => dataSource.getIssueBoard(signal), [dataSource]),
    [dataSource, options.refreshToken],
    options,
  );
}

export function useIssueDetail(issueId: string | null, refreshToken?: unknown): Loadable<IssueDetailModel | null> {
  const dataSource = useDataSource();
  const normalizedIssueId = issueId || null;
  const [state, setState] = useState<Loadable<IssueDetailModel | null> & { issueId: string | null }>({
    issueId: normalizedIssueId,
    data: null,
    loading: Boolean(normalizedIssueId),
    error: null,
  });

  useEffect(() => {
    let active = true;
    if (!normalizedIssueId) {
      setState({ issueId: null, data: null, loading: false, error: null });
      return () => {
        active = false;
      };
    }

    const controller = new AbortController();
    setState((current) => ({
      issueId: normalizedIssueId,
      data: current.issueId === normalizedIssueId ? current.data : null,
      loading: true,
      error: null,
    }));
    dataSource
      .getIssueDetail(normalizedIssueId, controller.signal)
      .then((data) => {
        if (active) setState({ issueId: normalizedIssueId, data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({
          issueId: normalizedIssueId,
          data: current.issueId === normalizedIssueId ? current.data : null,
          loading: false,
          error: message,
        }));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [dataSource, normalizedIssueId, refreshToken]);

  if (state.issueId !== normalizedIssueId) {
    return { data: null, loading: Boolean(normalizedIssueId), error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
}

export function useHistory(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback((signal?: AbortSignal) => dataSource.getHistory(signal), [dataSource]),
    [dataSource, options.refreshToken],
    options,
  );
}

interface TranscriptPatchCursor {
  sessionId: string | null;
  lastSequence: number | null;
  lastRevision: number | null;
  tailLimit: number;
  refetchHref: string | null;
  canAppend: boolean;
}

function createTranscriptPatchCursor(sessionId: string | null = null): TranscriptPatchCursor {
  return {
    sessionId,
    lastSequence: null,
    lastRevision: null,
    tailLimit: 500,
    refetchHref: null,
    canAppend: false,
  };
}

interface TranscriptState extends Loadable<TranscriptMessage[]> {
  sessionId: string | null;
  page: TranscriptWindowPageModel | null;
  window: TranscriptWindowModel | null;
  activeTail: TranscriptActiveTailModel | null;
  loadingPrevious: boolean;
  previousError: string | null;
}

export interface TranscriptLoadable extends Loadable<TranscriptMessage[]> {
  page: TranscriptWindowPageModel | null;
  window: TranscriptWindowModel | null;
  activeTail: TranscriptActiveTailModel | null;
  hasPrevious: boolean;
  loadingPrevious: boolean;
  previousError: string | null;
  loadPrevious: () => Promise<void>;
}

function createTranscriptState(sessionId: string | null, loading = Boolean(sessionId)): TranscriptState {
  return {
    sessionId,
    data: sessionId ? null : [],
    loading,
    error: null,
    page: null,
    window: null,
    activeTail: null,
    loadingPrevious: false,
    previousError: null,
  };
}

export function useTranscript(sessionId: string | null, refreshToken?: unknown): TranscriptLoadable {
  const dataSource = useDataSource();
  const normalizedSessionId = sessionId || null;
  const [patchRefreshToken, setPatchRefreshToken] = useState(0);
  const patchCursor = useRef<TranscriptPatchCursor>(createTranscriptPatchCursor());
  const previousLoadRef = useRef<{ sessionId: string; controller: AbortController } | null>(null);
  const [state, setState] = useState<TranscriptState>(() => createTranscriptState(normalizedSessionId));
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let active = true;
    if (!normalizedSessionId) {
      patchCursor.current = createTranscriptPatchCursor();
      previousLoadRef.current?.controller.abort();
      previousLoadRef.current = null;
      const nextState = createTranscriptState(null, false);
      stateRef.current = nextState;
      setState(nextState);
      return () => {
        active = false;
      };
    }

    if (patchCursor.current.sessionId !== normalizedSessionId) {
      patchCursor.current = createTranscriptPatchCursor(normalizedSessionId);
    }

    const controller = new AbortController();
    setState((current) => {
      const nextState = {
        ...current,
        sessionId: normalizedSessionId,
        data: current.sessionId === normalizedSessionId ? current.data : null,
        loading: true,
        error: null,
        loadingPrevious: false,
        previousError: null,
      };
      stateRef.current = nextState;
      return nextState;
    });
    dataSource
      .getTranscript(normalizedSessionId, controller.signal, { tail: true })
      .then((transcriptWindow) => {
        if (!active) return;
        patchCursor.current = {
          ...patchCursor.current,
          sessionId: normalizedSessionId,
          lastSequence: transcriptWindow.activeTail.afterSequence ?? transcriptWindow.window.lastSequence ?? transcriptWindow.page.lastSequence,
          tailLimit: transcriptWindow.activeTail.tailLimit || transcriptWindow.window.tailLimit || 500,
          refetchHref: transcriptWindow.activeTail.refetchHref ?? transcriptWindow.recovery.href,
          canAppend: transcriptWindow.activeTail.canAppend === true,
        };
        const nextState = {
          sessionId: normalizedSessionId,
          data: transcriptWindow.messages,
          loading: false,
          error: null,
          page: transcriptWindow.page,
          window: transcriptWindow.window,
          activeTail: transcriptWindow.activeTail,
          loadingPrevious: false,
          previousError: null,
        };
        stateRef.current = nextState;
        setState(nextState);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => {
          const nextState = {
            ...current,
            sessionId: normalizedSessionId,
            data: current.sessionId === normalizedSessionId ? current.data : null,
            loading: false,
            error: message,
          };
          stateRef.current = nextState;
          return nextState;
        });
      });

    return () => {
      active = false;
      controller.abort();
      if (previousLoadRef.current?.sessionId === normalizedSessionId) {
        previousLoadRef.current.controller.abort();
        previousLoadRef.current = null;
      }
    };
  }, [dataSource, normalizedSessionId, refreshToken, patchRefreshToken]);

  useEffect(() => {
    if (!normalizedSessionId || !dataSource.subscribeToRealtimeEvents) return undefined;
    return dataSource.subscribeToRealtimeEvents((event) => {
      if (event.type !== "transcript.delta") return;
      const cursor = patchCursor.current;
      if (cursor.sessionId !== normalizedSessionId || !cursor.canAppend) return;
      const outcome = applyTranscriptDeltaEvent({
        event,
        sessionId: normalizedSessionId,
        current: stateRef.current.sessionId === normalizedSessionId ? stateRef.current.data : null,
        lastSequence: cursor.lastSequence,
        lastRevision: cursor.lastRevision,
        tailLimit: transcriptRealtimeTailLimit(cursor.tailLimit, stateRef.current.data),
      });
      if (outcome.action === "ignored") return;
      const nextCursor: TranscriptPatchCursor = {
        ...cursor,
        lastSequence: outcome.lastSequence ?? cursor.lastSequence,
        lastRevision: outcome.lastRevision ?? cursor.lastRevision,
      };
      patchCursor.current = nextCursor;
      if (outcome.action === "fallback") {
        dataSource.invalidateCachedReads?.({
          forceRefreshHrefs: [nextCursor.refetchHref ?? `/api/v1/web/sessions/${encodeURIComponent(normalizedSessionId)}/transcript?refresh=1`],
        });
        setPatchRefreshToken((current) => current + 1);
        return;
      }
      const currentState = stateRef.current;
      const nextActiveTail = currentState.activeTail
        ? { ...currentState.activeTail, afterSequence: outcome.lastSequence ?? currentState.activeTail.afterSequence }
        : currentState.activeTail;
      const nextState = {
        ...currentState,
        sessionId: normalizedSessionId,
        data: outcome.data,
        loading: false,
        error: null,
        activeTail: nextActiveTail,
      };
      stateRef.current = nextState;
      setState(nextState);
    });
  }, [dataSource, normalizedSessionId]);

  const loadPrevious = useCallback(async () => {
    const current = stateRef.current;
    if (!normalizedSessionId || current.sessionId !== normalizedSessionId || current.loadingPrevious) return;
    const previousPage = previousTranscriptPageRequest(current.page);
    if (!previousPage) return;

    previousLoadRef.current?.controller.abort();
    const controller = new AbortController();
    previousLoadRef.current = { sessionId: normalizedSessionId, controller };
    setState((latest) => {
      if (latest.sessionId !== normalizedSessionId) return latest;
      const nextState = { ...latest, loadingPrevious: true, previousError: null };
      stateRef.current = nextState;
      return nextState;
    });

    try {
      const transcriptWindow = await dataSource.getTranscript(normalizedSessionId, controller.signal, previousPage);
      if (controller.signal.aborted) return;
      setState((latest) => {
        if (latest.sessionId !== normalizedSessionId) return latest;
        const merged = mergeBackfilledTranscriptMessages(transcriptWindow.messages, latest.data ?? []);
        const nextState = {
          ...latest,
          data: merged,
          page: mergeBackfilledTranscriptPage(transcriptWindow.page, latest.page),
          window: latest.window
            ? { ...latest.window, messageCount: merged.length }
            : { ...transcriptWindow.window, messageCount: merged.length },
          loadingPrevious: false,
          previousError: null,
        };
        stateRef.current = nextState;
        return nextState;
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setState((latest) => {
        if (latest.sessionId !== normalizedSessionId) return latest;
        const nextState = { ...latest, loadingPrevious: false, previousError: message };
        stateRef.current = nextState;
        return nextState;
      });
    } finally {
      if (previousLoadRef.current?.controller === controller) previousLoadRef.current = null;
    }
  }, [dataSource, normalizedSessionId]);

  if (state.sessionId !== normalizedSessionId) {
    return {
      ...createTranscriptState(normalizedSessionId),
      hasPrevious: false,
      loadPrevious,
    };
  }

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    page: state.page,
    window: state.window,
    activeTail: state.activeTail,
    hasPrevious: state.page?.hasPrevious === true,
    loadingPrevious: state.loadingPrevious,
    previousError: state.previousError,
    loadPrevious,
  };
}

function previousTranscriptPageRequest(page: TranscriptWindowPageModel | null): { offset: number; limit: number } | null {
  if (!page?.hasPrevious) return null;
  const previousOffset = page.previousOffset;
  if (typeof previousOffset !== "number" || !Number.isFinite(previousOffset)) return null;
  if (previousOffset < 0 || previousOffset >= page.offset) return null;
  return { offset: previousOffset, limit: Math.max(1, page.offset - previousOffset) };
}

function transcriptRealtimeTailLimit(defaultTailLimit: number, current: readonly TranscriptMessage[] | null): number {
  if (!current || current.length <= defaultTailLimit) return defaultTailLimit;
  return current.length + 50;
}

function mergeBackfilledTranscriptMessages(
  backfillMessages: readonly TranscriptMessage[],
  currentMessages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const currentPreludeLength = leadingRunPreludeLength(currentMessages);
  if (currentPreludeLength === 0) return [...backfillMessages, ...currentMessages];
  const backfillPreludeLength = leadingRunPreludeLength(backfillMessages);
  if (!sameTranscriptPrelude(backfillMessages.slice(0, backfillPreludeLength), currentMessages.slice(0, currentPreludeLength))) {
    return [...backfillMessages, ...currentMessages];
  }
  return [
    ...currentMessages.slice(0, currentPreludeLength),
    ...backfillMessages.slice(backfillPreludeLength),
    ...currentMessages.slice(currentPreludeLength),
  ];
}

function leadingRunPreludeLength(messages: readonly TranscriptMessage[]): number {
  let length = 0;
  if (messages[length]?.kind === "system") length += 1;
  if (messages[length]?.kind === "user") length += 1;
  return length;
}

function sameTranscriptPrelude(left: readonly TranscriptMessage[], right: readonly TranscriptMessage[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => JSON.stringify(message) === JSON.stringify(right[index]));
}

function mergeBackfilledTranscriptPage(
  backfillPage: TranscriptWindowPageModel,
  currentPage: TranscriptWindowPageModel | null,
): TranscriptWindowPageModel {
  if (!currentPage) return backfillPage;
  return {
    ...backfillPage,
    nextOffset: currentPage.nextOffset,
    hasNext: currentPage.hasNext,
    lastSequence: currentPage.lastSequence,
    lastEventAt: currentPage.lastEventAt,
  };
}

export function useSidebar(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback((signal?: AbortSignal) => dataSource.getSidebar(signal), [dataSource]),
    [dataSource, options.refreshToken],
    options,
  );
}

export function useOrchestratorChat(options: SymphonyResourceOptions = {}): Loadable<OrchestratorChatModel> {
  const dataSource = useDataSource();
  const enabled = options.enabled ?? true;
  const [patchRefreshToken, setPatchRefreshToken] = useState(0);
  const lastRevision = useRef<number | null>(null);
  const [state, setState] = useState<Loadable<OrchestratorChatModel> & { enabled: boolean }>({ data: null, loading: enabled, error: null, enabled });
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!enabled) {
      setState((current) => {
        const nextState = { data: current.data, loading: false, error: null, enabled: false };
        stateRef.current = nextState;
        return nextState;
      });
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    setState((current) => {
      const nextState = { data: current.data, loading: true, error: null, enabled: true };
      stateRef.current = nextState;
      return nextState;
    });
    dataSource
      .getOrchestratorChat(controller.signal)
      .then((data) => {
        if (!active) return;
        const nextState = { data, loading: false, error: null, enabled: true };
        stateRef.current = nextState;
        setState(nextState);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => {
          const nextState = { data: current.data, loading: false, error: message, enabled: true };
          stateRef.current = nextState;
          return nextState;
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [dataSource, enabled, options.refreshToken, patchRefreshToken]);

  useEffect(() => {
    if (!enabled || !dataSource.subscribeToRealtimeEvents) return undefined;
    return dataSource.subscribeToRealtimeEvents((event) => {
      if (event.type !== "orchestrator.message") return;
      const payload = event.payload as RealtimeOrchestratorMessagePayload;
      const outcome = applyOrchestratorMessageEvent({
        event,
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        current: stateRef.current.enabled ? (stateRef.current.data?.chat ?? null) : null,
        lastRevision: lastRevision.current,
      });
      if (outcome.action === "ignored") return;
      lastRevision.current = outcome.lastRevision ?? lastRevision.current;
      if (outcome.action === "fallback") {
        dataSource.invalidateCachedReads?.({ forceRefreshHrefs: ["/api/v1/web/orchestrator-chat?refresh=1"] });
        setPatchRefreshToken((current) => current + 1);
        return;
      }
      const nextState = {
        data: mergeOrchestratorChatPatchModel(stateRef.current.data, outcome.data, outcome.lastRevision, payload),
        loading: false,
        error: null,
        enabled: true,
      };
      stateRef.current = nextState;
      setState(nextState);
    });
  }, [dataSource, enabled]);

  if (enabled && !state.enabled) return { data: state.data, loading: true, error: null };
  return { data: state.data, loading: state.loading, error: state.error };
}

function mergeOrchestratorChatPatchModel(
  current: OrchestratorChatModel | null,
  chat: ChatMessage[],
  revision: number,
  payload: RealtimeOrchestratorMessagePayload,
): OrchestratorChatModel {
  if (!current) return normalizeOrchestratorChatModel(chat);
  const latestMessage = chat.at(-1) ?? null;
  const latestMessageStatus = payload.lastMessageStatus ?? latestMessage?.status ?? null;
  const latestMessageUpdatedAt = payload.latestMessageUpdatedAt ?? latestMessage?.updatedAt ?? latestMessage?.createdAt ?? current.source.latestMessageUpdatedAt;
  const conversationStatus = payload.conversationStatus ?? payload.state ?? latestMessageStatus ?? current.conversation.status;
  const nextState = payload.state ?? latestMessageStatus ?? undefined;
  const messageCount = typeof payload.messageCount === "number" && Number.isInteger(payload.messageCount) && payload.messageCount >= 0
    ? payload.messageCount
    : Math.max(current.conversation.messageCount, chat.length);
  const statusSummary: Record<string, unknown> = {
    conversationStatus,
    latestMessageStatus,
    messageCount,
  };
  if (nextState) statusSummary.state = nextState;
  if (typeof payload.active === "boolean") statusSummary.active = payload.active;
  if (typeof payload.terminal === "boolean") statusSummary.terminal = payload.terminal;
  if (typeof payload.empty === "boolean") statusSummary.empty = payload.empty;
  if (payload.statusCounts) statusSummary.statusCounts = payload.statusCounts;
  return normalizeOrchestratorChatModel({
    schemaVersion: current.schemaVersion,
    ...(nextState ? { state: nextState } : {}),
    conversation: {
      ...current.conversation,
      status: conversationStatus,
      updatedAt: latestMessageUpdatedAt ?? current.conversation.updatedAt,
      messageCount,
    },
    status: statusSummary,
    chat,
    source: {
      ...current.source,
      revision: `${current.source.revision}:live:${revision}`,
      latestMessageSequence:
        typeof payload.latestMessageSequence === "number" && Number.isInteger(payload.latestMessageSequence)
          ? payload.latestMessageSequence
          : current.source.latestMessageSequence,
      latestMessageUpdatedAt,
    },
    compatibility: current.compatibility,
  });
}
