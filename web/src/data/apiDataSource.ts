import type {
  CacheInvalidationOptions,
  ProjectionChangeEvent,
  ProjectionChangeListener,
  ProjectionChangeUnsubscribe,
  SymphonyDataSource,
} from "./dataSource";
import { createRealtimeEventSourceClient } from "./eventSourceClient";
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
  invalidateCache(options?: CacheInvalidationOptions): void;
}

function createGetJsonFetcher(): GetJsonFetcher {
  const inFlight = new Map<string, InFlightGetResponse>();
  const successCache = new Map<string, CachedGetResponse>();
  const forceRefreshPaths = new Set<string>();
  let invalidationGeneration = 0;

  async function fetchJson<T>(baseUrl: string, path: string, options: FetchJsonOptions = {}): Promise<T> {
    const cacheKey = `${baseUrl}${path}`;
    const requestPath = consumeForceRefreshPath(forceRefreshPaths, path);
    const requestUrl = `${baseUrl}${requestPath}`;
    const { signal, cacheable = true } = options;
    if (!cacheable) return fetchJsonOnce<T>(requestUrl, signal);

    const cached = successCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return resolveCachedGet(cached.data as T, signal);

    const pending = inFlight.get(cacheKey);
    if (pending && pending.generation === invalidationGeneration) return resolveSharedGet(pending.promise as Promise<T>, signal);

    const requestGeneration = invalidationGeneration;
    const requestToken = Symbol(cacheKey);
    const promise = fetchJsonOnce<T>(requestUrl).then((data) => {
      const current = inFlight.get(cacheKey);
      if (current?.token === requestToken && requestGeneration === invalidationGeneration) {
        successCache.set(cacheKey, { data, expiresAt: Date.now() + GET_SUCCESS_CACHE_MS });
      }
      return data;
    });
    inFlight.set(cacheKey, { generation: requestGeneration, promise, token: requestToken });
    const clearIfCurrent = () => {
      if (inFlight.get(cacheKey)?.token === requestToken) inFlight.delete(cacheKey);
    };
    void promise.then(clearIfCurrent, clearIfCurrent);
    return resolveSharedGet(promise, signal);
  }

  return {
    fetchJson,
    invalidateCache(options) {
      invalidationGeneration += 1;
      successCache.clear();
      inFlight.clear();
      rememberForceRefreshHrefs(forceRefreshPaths, options?.forceRefreshHrefs ?? []);
    },
  };
}

function rememberForceRefreshHrefs(forceRefreshPaths: Set<string>, hrefs: readonly string[]): void {
  for (const href of hrefs) {
    const parsed = parseApiHref(href);
    if (!parsed?.hasRefreshHint) continue;
    forceRefreshPaths.add(parsed.pathname);
  }
}

function consumeForceRefreshPath(forceRefreshPaths: Set<string>, path: string): string {
  const parsed = parseApiHref(path);
  if (!parsed || !forceRefreshPaths.delete(parsed.pathname)) return path;
  return pathWithRefresh(path);
}

function parseApiHref(href: string): { pathname: string; hasRefreshHint: boolean } | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, "http://symphony.local");
    if (!url.pathname.startsWith("/api/v1/web/")) return null;
    return { pathname: url.pathname.replace(/\/+$/, ""), hasRefreshHint: isTruthyRefreshParam(url.searchParams.get("refresh")) };
  } catch {
    return null;
  }
}

function pathWithRefresh(path: string): string {
  const parsed = parseApiHref(path);
  if (parsed?.hasRefreshHint) return path;
  return `${path}${path.includes("?") ? "&" : "?"}refresh=1`;
}

function isTruthyRefreshParam(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "force";
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

function realtimeEventSourceUrl(baseUrl: string, lastEventId: string | null): string {
  const endpoint = `${baseUrl}/api/v1/realtime`;
  const normalizedLastEventId = lastEventId?.trim();
  if (!normalizedLastEventId) return endpoint;
  return `${endpoint}?lastEventId=${encodeURIComponent(normalizedLastEventId)}`;
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
  const realtimeEventSourceClient = createRealtimeEventSourceClient({
    urlForLastEventId: (lastEventId) => realtimeEventSourceUrl(normalizedBaseUrl, lastEventId),
  });

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
    invalidateCachedReads(options) {
      getJsonFetcher.invalidateCache(options);
    },
    subscribeToProjectionChanges(listener) {
      return openProjectionChangeSubscription(normalizedBaseUrl, listener);
    },
    subscribeToRealtimeEvents(listener, options) {
      return realtimeEventSourceClient.subscribe(listener, options);
    },
  };
}
