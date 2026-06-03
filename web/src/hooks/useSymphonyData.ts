import { useCallback, useEffect, useRef, useState } from "react";
import { useDataSource } from "../data/dataSourceContext";
import { normalizeOrchestratorChatModel } from "../data/orchestratorChat";
import { useAsyncResource } from "./useAsyncResource";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  applyOrchestratorMessageEvent,
  applyTranscriptDeltaEvent,
} from "../data/realtimePatches";
import type { ChatMessage, IssueDetailModel, Loadable, OrchestratorChatModel, TranscriptMessage } from "../types/symphony";

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

export function useTranscript(sessionId: string | null, refreshToken?: unknown): Loadable<TranscriptMessage[]> {
  const dataSource = useDataSource();
  const normalizedSessionId = sessionId || null;
  const [patchRefreshToken, setPatchRefreshToken] = useState(0);
  const patchCursor = useRef<{ lastSequence: number | null; lastRevision: number | null }>({ lastSequence: null, lastRevision: null });
  const [state, setState] = useState<Loadable<TranscriptMessage[]> & { sessionId: string | null }>({
    sessionId: normalizedSessionId,
    data: normalizedSessionId ? null : [],
    loading: Boolean(normalizedSessionId),
    error: null,
  });
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let active = true;
    if (!normalizedSessionId) {
      patchCursor.current = { lastSequence: null, lastRevision: null };
      const nextState = { sessionId: null, data: [], loading: false, error: null };
      stateRef.current = nextState;
      setState(nextState);
      return () => {
        active = false;
      };
    }

    const controller = new AbortController();
    setState((current) => {
      const nextState = {
        sessionId: normalizedSessionId,
        data: current.sessionId === normalizedSessionId ? current.data : null,
        loading: true,
        error: null,
      };
      stateRef.current = nextState;
      return nextState;
    });
    dataSource
      .getTranscript(normalizedSessionId, controller.signal)
      .then((data) => {
        if (!active) return;
        patchCursor.current = { ...patchCursor.current, lastSequence: null };
        const nextState = { sessionId: normalizedSessionId, data, loading: false, error: null };
        stateRef.current = nextState;
        setState(nextState);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => {
          const nextState = {
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
    };
  }, [dataSource, normalizedSessionId, refreshToken, patchRefreshToken]);

  useEffect(() => {
    if (!normalizedSessionId || !dataSource.subscribeToRealtimeEvents) return undefined;
    return dataSource.subscribeToRealtimeEvents((event) => {
      if (event.type !== "transcript.delta") return;
      const outcome = applyTranscriptDeltaEvent({
        event,
        sessionId: normalizedSessionId,
        current: stateRef.current.sessionId === normalizedSessionId ? stateRef.current.data : null,
        lastSequence: patchCursor.current.lastSequence,
        lastRevision: patchCursor.current.lastRevision,
      });
      if (outcome.action === "ignored") return;
      patchCursor.current = {
        lastSequence: outcome.lastSequence ?? patchCursor.current.lastSequence,
        lastRevision: outcome.lastRevision ?? patchCursor.current.lastRevision,
      };
      if (outcome.action === "fallback") {
        dataSource.invalidateCachedReads?.({ forceRefreshHrefs: [`/api/v1/web/sessions/${encodeURIComponent(normalizedSessionId)}/transcript?refresh=1`] });
        setPatchRefreshToken((current) => current + 1);
        return;
      }
      const nextState = { sessionId: normalizedSessionId, data: outcome.data, loading: false, error: null };
      stateRef.current = nextState;
      setState(nextState);
    });
  }, [dataSource, normalizedSessionId]);

  if (state.sessionId !== normalizedSessionId) {
    return { data: normalizedSessionId ? null : [], loading: Boolean(normalizedSessionId), error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
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
        data: mergeOrchestratorChatPatchModel(stateRef.current.data, outcome.data, outcome.lastRevision),
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
): OrchestratorChatModel {
  if (!current) return normalizeOrchestratorChatModel(chat);
  const latestMessage = chat.at(-1) ?? null;
  const latestMessageUpdatedAt = latestMessage?.updatedAt ?? latestMessage?.createdAt ?? current.source.latestMessageUpdatedAt;
  return normalizeOrchestratorChatModel({
    schemaVersion: current.schemaVersion,
    conversation: {
      ...current.conversation,
      updatedAt: latestMessageUpdatedAt ?? current.conversation.updatedAt,
      messageCount: Math.max(current.conversation.messageCount, chat.length),
    },
    chat,
    source: {
      ...current.source,
      revision: `${current.source.revision}:live:${revision}`,
      latestMessageUpdatedAt,
    },
    compatibility: current.compatibility,
  });
}
