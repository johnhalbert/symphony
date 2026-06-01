import type { ProjectionChangeEvent, ProjectionChangeListener, ProjectionChangeUnsubscribe, SymphonyDataSource } from "./dataSource";
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

interface InFlightGetResponse {
  generation: number;
  promise: Promise<unknown>;
  token: symbol;
}

interface FetchJsonOptions {
  signal?: AbortSignal;
  cacheable?: boolean;
}

interface GetJsonFetcher {
  fetchJson<T>(baseUrl: string, path: string, options?: FetchJsonOptions): Promise<T>;
  invalidateCache(): void;
}

function createGetJsonFetcher(): GetJsonFetcher {
  const inFlight = new Map<string, InFlightGetResponse>();
  const successCache = new Map<string, CachedGetResponse>();
  let invalidationGeneration = 0;

  async function fetchJson<T>(baseUrl: string, path: string, options: FetchJsonOptions = {}): Promise<T> {
    const url = `${baseUrl}${path}`;
    const { signal, cacheable = true } = options;
    if (!cacheable) return fetchJsonOnce<T>(url, signal);

    const cached = successCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return resolveCachedGet(cached.data as T, signal);

    const pending = inFlight.get(url);
    if (pending && pending.generation === invalidationGeneration) return resolveSharedGet(pending.promise as Promise<T>, signal);

    const requestGeneration = invalidationGeneration;
    const requestToken = Symbol(url);
    const promise = fetchJsonOnce<T>(url).then((data) => {
      const current = inFlight.get(url);
      if (current?.token === requestToken && requestGeneration === invalidationGeneration) {
        successCache.set(url, { data, expiresAt: Date.now() + GET_SUCCESS_CACHE_MS });
      }
      return data;
    });
    inFlight.set(url, { generation: requestGeneration, promise, token: requestToken });
    const clearIfCurrent = () => {
      if (inFlight.get(url)?.token === requestToken) inFlight.delete(url);
    };
    void promise.then(clearIfCurrent, clearIfCurrent);
    return resolveSharedGet(promise, signal);
  }

  return {
    fetchJson,
    invalidateCache() {
      invalidationGeneration += 1;
      successCache.clear();
      inFlight.clear();
    },
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

function openProjectionChangeSubscription(baseUrl: string, listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
  if (typeof EventSource === "undefined") return () => undefined;

  const eventSource = new EventSource(`${baseUrl}/api/v1/web/events`);
  const handleProjectionEvent = (event: MessageEvent) => {
    listener(parseProjectionChangeEvent(event));
  };
  eventSource.addEventListener("projection_revision", handleProjectionEvent);
  eventSource.addEventListener("projection_closed", handleProjectionEvent);
  eventSource.addEventListener("message", handleProjectionEvent);
  return () => {
    eventSource.close();
  };
}

function parseProjectionChangeEvent(event: MessageEvent): ProjectionChangeEvent {
  if (typeof event.data !== "string") return { type: event.type };
  try {
    const parsed = JSON.parse(event.data) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as ProjectionChangeEvent;
    }
  } catch {
    // Ignore malformed SSE payloads; the caller can still treat the event type as a coarse invalidation signal.
  }
  return { type: event.type };
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

export function createApiDataSource(baseUrl: string): SymphonyDataSource {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const getJsonFetcher = createGetJsonFetcher();
  const { fetchJson } = getJsonFetcher;

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
      return fetchJson<ChatMessage[]>(normalizedBaseUrl, "/api/v1/web/orchestrator-chat", { signal });
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
    invalidateCachedReads() {
      getJsonFetcher.invalidateCache();
    },
    subscribeToProjectionChanges(listener) {
      return openProjectionChangeSubscription(normalizedBaseUrl, listener);
    },
  };
}
