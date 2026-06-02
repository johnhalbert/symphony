import { useEffect, useState } from "react";
import { useDataSource } from "../data/dataSourceContext";
import type { RealtimeProjectionEvent, RealtimeProjectionResource, RealtimeResourceKind } from "../data/dataSource";

export const LIVE_RESOURCE_KEYS = [
  "referenceData",
  "dashboard",
  "issueBoard",
  "issueDetail",
  "history",
  "sidebar",
  "sessionTranscript",
  "orchestratorChat",
] as const;

export type LiveResourceKey = (typeof LIVE_RESOURCE_KEYS)[number];
export type LiveResourceTokenMap = Record<LiveResourceKey, number>;

const ZERO_LIVE_RESOURCE_TOKENS = createLiveResourceTokenMap();
const ALL_LIVE_RESOURCE_KEYS = [...LIVE_RESOURCE_KEYS];

const RESOURCE_KIND_TO_LIVE_KEYS: Record<RealtimeResourceKind, readonly LiveResourceKey[]> = {
  dashboard: ["dashboard"],
  "issue-board": ["issueBoard"],
  "issue-detail": ["issueDetail"],
  history: ["history"],
  sidebar: ["sidebar"],
  "session-transcript": ["sessionTranscript"],
  "orchestrator-chat": ["orchestratorChat"],
  source: ["referenceData"],
};

const LIVE_RESOURCE_PATH_MATCHERS: ReadonlyArray<{ key: LiveResourceKey; matches(pathname: string): boolean }> = [
  { key: "referenceData", matches: (pathname) => pathname === "/api/v1/web/reference-data" },
  { key: "dashboard", matches: (pathname) => pathname === "/api/v1/web/dashboard" },
  { key: "issueDetail", matches: (pathname) => /^\/api\/v1\/web\/issues\/[^/]+$/.test(pathname) },
  { key: "issueBoard", matches: (pathname) => pathname === "/api/v1/web/issues" },
  { key: "history", matches: (pathname) => pathname === "/api/v1/web/history" },
  { key: "sessionTranscript", matches: (pathname) => /^\/api\/v1\/web\/sessions\/[^/]+\/transcript$/.test(pathname) },
  { key: "sidebar", matches: (pathname) => pathname === "/api/v1/web/sidebar" },
  { key: "orchestratorChat", matches: (pathname) => pathname === "/api/v1/web/orchestrator-chat" },
];

export function useLiveResourceTokens(enabled: boolean): LiveResourceTokenMap {
  const dataSource = useDataSource();
  const [tokens, setTokens] = useState<LiveResourceTokenMap>(() => createLiveResourceTokenMap());

  useEffect(() => {
    if (!enabled) return undefined;
    if (dataSource.subscribeToRealtimeEvents) {
      return dataSource.subscribeToRealtimeEvents((event) => {
        const keys = liveResourceKeysForRealtimeEvent(event);
        if (keys.length === 0) return;
        dataSource.invalidateCachedReads?.({ forceRefreshHrefs: realtimeRefreshHrefsForEvent(event) });
        setTokens((current) => incrementLiveResourceTokens(current, keys));
      });
    }
    if (dataSource.subscribeToProjectionChanges) {
      return dataSource.subscribeToProjectionChanges((event) => {
        if (event.type !== "projection_revision") return;
        dataSource.invalidateCachedReads?.();
        setTokens((current) => incrementLiveResourceTokens(current, ALL_LIVE_RESOURCE_KEYS));
      });
    }
    return undefined;
  }, [dataSource, enabled]);

  return enabled ? tokens : ZERO_LIVE_RESOURCE_TOKENS;
}

export function createLiveResourceTokenMap(): LiveResourceTokenMap {
  return {
    referenceData: 0,
    dashboard: 0,
    issueBoard: 0,
    issueDetail: 0,
    history: 0,
    sidebar: 0,
    sessionTranscript: 0,
    orchestratorChat: 0,
  };
}

export function liveResourceKeysForRealtimeEvent(event: RealtimeProjectionEvent): readonly LiveResourceKey[] {
  const keys = new Set<LiveResourceKey>();
  for (const resource of event.resources) {
    addLiveResourceKeysForResource(keys, resource);
  }
  for (const endpoint of event.recovery.endpoints) {
    addLiveResourceKeysForHref(keys, endpoint);
  }
  if (keys.size === 0 && (event.missedEvents || event.recovery.reason === "missed-events")) {
    for (const key of ALL_LIVE_RESOURCE_KEYS) keys.add(key);
  }
  return [...keys];
}

export function realtimeRefreshHrefsForEvent(event: RealtimeProjectionEvent): readonly string[] {
  const hrefs = new Set<string>();
  for (const resource of event.resources) hrefs.add(resource.href);
  for (const endpoint of event.recovery.endpoints) hrefs.add(endpoint);
  return [...hrefs];
}

export function combineLiveResourceTokens(tokens: LiveResourceTokenMap, keys: readonly LiveResourceKey[]): number {
  return keys.reduce((total, key) => total + tokens[key], 0);
}

function incrementLiveResourceTokens(current: LiveResourceTokenMap, keys: readonly LiveResourceKey[]): LiveResourceTokenMap {
  if (keys.length === 0) return current;
  const next = { ...current };
  for (const key of new Set(keys)) {
    next[key] += 1;
  }
  return next;
}

function addLiveResourceKeysForResource(keys: Set<LiveResourceKey>, resource: RealtimeProjectionResource): void {
  for (const key of RESOURCE_KIND_TO_LIVE_KEYS[resource.kind]) keys.add(key);
  addLiveResourceKeysForHref(keys, resource.href);
}

function addLiveResourceKeysForHref(keys: Set<LiveResourceKey>, href: string): void {
  const pathname = normalizeRealtimeHrefPath(href);
  if (!pathname) return;
  for (const matcher of LIVE_RESOURCE_PATH_MATCHERS) {
    if (matcher.matches(pathname)) keys.add(matcher.key);
  }
}

function normalizeRealtimeHrefPath(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, "http://symphony.local");
    return url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
