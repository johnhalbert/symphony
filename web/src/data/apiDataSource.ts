import type { OrchestratorChatErrorListener, OrchestratorChatListener, SymphonyDataSource } from "./dataSource";
import type { ChatMessage, ReferenceData } from "../types/symphony";

interface ApiReferenceEntry {
  name?: string | null;
  color?: string | null;
}

interface ApiReferenceData {
  users?: Record<string, ApiReferenceEntry | null> | null;
  labels?: Record<string, ApiReferenceEntry | null> | null;
}

const GET_SUCCESS_CACHE_MS = 5_000;

interface CachedGetResponse {
  data: unknown;
  expiresAt: number;
}

interface FetchJsonOptions {
  signal?: AbortSignal;
  cacheable?: boolean;
}

function createGetJsonFetcher() {
  const inFlight = new Map<string, Promise<unknown>>();
  const successCache = new Map<string, CachedGetResponse>();

  return async function fetchJson<T>(baseUrl: string, path: string, options: FetchJsonOptions = {}): Promise<T> {
    const url = `${baseUrl}${path}`;
    const { signal, cacheable = true } = options;
    if (!cacheable) return fetchJsonOnce<T>(url, signal);

    const cached = successCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return resolveCachedGet(cached.data as T, signal);

    const pending = inFlight.get(url);
    if (pending) return resolveSharedGet(pending as Promise<T>, signal);

    const promise = fetchJsonOnce<T>(url).then((data) => {
      successCache.set(url, { data, expiresAt: Date.now() + GET_SUCCESS_CACHE_MS });
      return data;
    });
    inFlight.set(url, promise);
    void promise.then(
      () => inFlight.delete(url),
      () => inFlight.delete(url),
    );
    return resolveSharedGet(promise, signal);
  };
}

function resolveCachedGet<T>(data: T, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return Promise.resolve(data);
}

function resolveSharedGet<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (data) => {
        signal.removeEventListener("abort", onAbort);
        resolve(data);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function fetchJsonOnce<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Symphony API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function normalizeReferenceRecord(record: Record<string, ApiReferenceEntry | null> | null | undefined) {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, entry]) => [
      key,
      {
        name: entry?.name?.trim() || key,
        color: entry?.color ?? null,
      },
    ]),
  );
}

export function normalizeReferenceData(input: ApiReferenceData): ReferenceData {
  return {
    users: normalizeReferenceRecord(input.users),
    labels: normalizeReferenceRecord(input.labels),
  };
}

function subscribeToOrchestratorChatEvents(
  baseUrl: string,
  onMessages: OrchestratorChatListener,
  onError?: OrchestratorChatErrorListener,
): () => void {
  if (typeof EventSource === "undefined") {
    onError?.("This browser does not support live orchestrator chat updates.");
    return () => undefined;
  }

  const source = new EventSource(`${baseUrl}/api/v1/web/orchestrator-chat/events`);
  source.addEventListener("orchestrator_chat", (event) => {
    try {
      const messages = JSON.parse((event as MessageEvent<string>).data) as ChatMessage[];
      if (Array.isArray(messages)) onMessages(messages);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  });
  source.addEventListener("orchestrator_chat_error", (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
      onError?.(payload.message || "Orchestrator chat stream reported an error.");
    } catch {
      onError?.("Orchestrator chat stream reported an error.");
    }
  });
  source.onerror = () => {
    onError?.("Orchestrator chat live updates disconnected; the browser will retry automatically.");
  };
  return () => source.close();
}

export function createApiDataSource(baseUrl: string): SymphonyDataSource {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const fetchJson = createGetJsonFetcher();

  return {
    async getReferenceData(signal) {
      return normalizeReferenceData(await fetchJson<ApiReferenceData>(normalizedBaseUrl, "/api/v1/web/reference-data", { signal }));
    },
    async getDashboard(signal) {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/dashboard", { signal });
    },
    async getIssueBoard(signal) {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/issues", { signal });
    },
    async getIssueDetail(issueId, signal) {
      return fetchJson(normalizedBaseUrl, `/api/v1/web/issues/${encodeURIComponent(issueId)}`, { signal, cacheable: false });
    },
    async getHistory(signal) {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/history", { signal });
    },
    async getSessions(signal) {
      const history = await this.getHistory(signal);
      return history.sessions;
    },
    async getTranscript(sessionId, signal) {
      return fetchJson(normalizedBaseUrl, `/api/v1/web/sessions/${encodeURIComponent(sessionId)}/transcript`, { signal, cacheable: false });
    },
    async getSidebar(signal) {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/sidebar", { signal });
    },
    async getOrchestratorChat(signal) {
      return fetchJson<ChatMessage[]>(normalizedBaseUrl, "/api/v1/web/orchestrator-chat", { signal, cacheable: false });
    },
    async sendOrchestratorMessage(input) {
      const response = await fetch(`${normalizedBaseUrl}/api/v1/web/orchestrator-chat`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input }),
      });
      if (!response.ok) throw new Error(`Symphony API returned HTTP ${response.status}`);
      return response.json() as Promise<ChatMessage[]>;
    },
    subscribeOrchestratorChat(onMessages, onError) {
      return subscribeToOrchestratorChatEvents(normalizedBaseUrl, onMessages, onError);
    },
  };
}
