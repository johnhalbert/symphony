import { useEffect, useRef, useState } from "react";
import { useDataSource } from "../data/dataSourceContext";
import { realtimeConnectionStatus } from "../data/realtimeEvents";
import type { RealtimeConnectionStatus, RealtimeProjectionEvent, RealtimeProjectionResource, RealtimeResourceKind } from "../data/dataSource";

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
export type LiveResourceRevisionMap = Record<LiveResourceKey, number | null>;

const ZERO_LIVE_RESOURCE_TOKENS = createLiveResourceTokenMap();
const ZERO_LIVE_RESOURCE_REVISIONS = createLiveResourceRevisionMap();
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

const DEFAULT_HREFS_BY_RESOURCE_KIND: Partial<Record<RealtimeResourceKind, readonly string[]>> = {
  dashboard: ["/api/v1/web/dashboard"],
  "issue-board": ["/api/v1/web/issues"],
  history: ["/api/v1/web/history"],
  sidebar: ["/api/v1/web/sidebar"],
  "orchestrator-chat": ["/api/v1/web/orchestrator-chat"],
  source: ["/api/v1/web/reference-data?refresh=1"],
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

export interface LiveResourceState {
  tokens: LiveResourceTokenMap;
  revisions: LiveResourceRevisionMap;
  realtimeStatus: RealtimeConnectionStatus;
}

export function useLiveResourceTokens(enabled: boolean): LiveResourceTokenMap {
  return useLiveResourceState(enabled).tokens;
}

export function useLiveResourceState(enabled: boolean): LiveResourceState {
  const dataSource = useDataSource();
  const liveResourceRevisions = useRef<LiveResourceRevisionMap>(createLiveResourceRevisionMap());
  const [tokens, setTokens] = useState<LiveResourceTokenMap>(() => createLiveResourceTokenMap());
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>(() => realtimeConnectionStatus(enabled ? "connecting" : "unavailable"));

  useEffect(() => {
    liveResourceRevisions.current = createLiveResourceRevisionMap();
    if (!enabled) {
      setRealtimeStatus(realtimeConnectionStatus("unavailable"));
      return undefined;
    }
    if (dataSource.subscribeToRealtimeEvents) {
      setRealtimeStatus(realtimeConnectionStatus("connecting"));
      return dataSource.subscribeToRealtimeEvents(
        (event) => {
          const keys = applyRealtimeEventToLiveResourceRevisions(liveResourceRevisions.current, event);
          if (keys.length === 0) return;
          const forceRefreshHrefs = realtimeRefreshHrefsForEvent(event, keys);
          if (forceRefreshHrefs.length > 0) {
            dataSource.invalidateCachedReads?.({ forceRefreshHrefs });
          } else if (shouldBroadlyInvalidateRealtimeEvent(event)) {
            dataSource.invalidateCachedReads?.();
          }
          setTokens((current) => incrementLiveResourceTokens(current, keys));
        },
        { onStatus: setRealtimeStatus },
      );
    }
    setRealtimeStatus(realtimeConnectionStatus("unavailable"));
    if (dataSource.subscribeToProjectionChanges) {
      return dataSource.subscribeToProjectionChanges((event) => {
        if (event.type !== "projection_revision") return;
        const revision = typeof event.revision === "number" && Number.isFinite(event.revision) ? event.revision : null;
        if (revision !== null) recordLiveResourceRevisions(liveResourceRevisions.current, ALL_LIVE_RESOURCE_KEYS, revision);
        dataSource.invalidateCachedReads?.();
        setTokens((current) => incrementLiveResourceTokens(current, ALL_LIVE_RESOURCE_KEYS));
      });
    }
    return undefined;
  }, [dataSource, enabled]);

  return {
    tokens: enabled ? tokens : ZERO_LIVE_RESOURCE_TOKENS,
    revisions: enabled ? liveResourceRevisions.current : ZERO_LIVE_RESOURCE_REVISIONS,
    realtimeStatus: enabled ? realtimeStatus : realtimeConnectionStatus("unavailable"),
  };
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

export function createLiveResourceRevisionMap(): LiveResourceRevisionMap {
  return {
    referenceData: null,
    dashboard: null,
    issueBoard: null,
    issueDetail: null,
    history: null,
    sidebar: null,
    sessionTranscript: null,
    orchestratorChat: null,
  };
}

export function applyRealtimeEventToLiveResourceRevisions(
  revisions: LiveResourceRevisionMap,
  event: RealtimeProjectionEvent,
): readonly LiveResourceKey[] {
  const keys = liveResourceKeysForRealtimeEvent(event);
  if (keys.length === 0) return [];

  const affectedKeys = isMissedEventsRecovery(event) ? keys : keys.filter((key) => isNewerProjectionRevision(event.revision, revisions[key]));
  recordLiveResourceRevisions(revisions, affectedKeys, event.revision);
  return affectedKeys;
}

export function liveResourceKeysForRealtimeEvent(event: RealtimeProjectionEvent): readonly LiveResourceKey[] {
  const keys = new Set<LiveResourceKey>();
  const projectionResourceKinds = projectionResourceKindsForEvent(event);
  if (usesProjectionResourceChanges(event)) {
    for (const kind of projectionResourceKinds) addLiveResourceKeysForKind(keys, kind);
  } else {
    for (const resource of event.resources) {
      addLiveResourceKeysForResource(keys, resource);
    }
    for (const kind of projectionResourceKinds) {
      addLiveResourceKeysForKind(keys, kind);
    }
  }
  for (const endpoint of event.recovery.endpoints) {
    if (usesProjectionResourceChanges(event) && !hrefMatchesAnyLiveResourceKey(endpoint, keys)) continue;
    addLiveResourceKeysForHref(keys, endpoint);
  }
  if (keys.size === 0 && isMissedEventsRecovery(event)) {
    for (const key of ALL_LIVE_RESOURCE_KEYS) keys.add(key);
  }
  return [...keys];
}

export function realtimeRefreshHrefsForEvent(event: RealtimeProjectionEvent, affectedKeys?: readonly LiveResourceKey[]): readonly string[] {
  const hrefs = new Set<string>();
  const affectedKeySet = affectedKeys ? new Set(affectedKeys) : null;
  const projectionResourceKinds = projectionResourceKindsForEvent(event);
  const projectionKeySet = usesProjectionResourceChanges(event) ? liveResourceKeySetForKinds(projectionResourceKinds) : null;
  const candidateKeySets = [projectionKeySet, affectedKeySet].filter((set): set is Set<LiveResourceKey> => set !== null);

  const addHref = (href: string) => {
    if (candidateKeySets.every((set) => hrefMatchesAnyLiveResourceKey(href, set))) hrefs.add(href);
  };
  const addDefaultHrefsForKind = (kind: RealtimeResourceKind) => {
    if (!candidateKeySets.every((set) => kindMatchesAnyLiveResourceKey(kind, set))) return;
    for (const href of DEFAULT_HREFS_BY_RESOURCE_KIND[kind] ?? []) hrefs.add(href);
  };

  if (usesProjectionResourceChanges(event)) {
    for (const kind of projectionResourceKinds) {
      for (const resource of event.resources) {
        if (resource.kind === kind) addHref(resource.href);
      }
      addDefaultHrefsForKind(kind);
    }
  } else {
    for (const resource of event.resources) addHref(resource.href);
    for (const kind of projectionResourceKinds) addDefaultHrefsForKind(kind);
  }
  for (const endpoint of event.recovery.endpoints) addHref(endpoint);
  return [...hrefs];
}

function liveResourceKeySetForKinds(kinds: readonly RealtimeResourceKind[]): Set<LiveResourceKey> {
  const keys = new Set<LiveResourceKey>();
  for (const kind of kinds) {
    addLiveResourceKeysForKind(keys, kind);
  }
  return keys;
}

function kindMatchesAnyLiveResourceKey(kind: RealtimeResourceKind, keys: ReadonlySet<LiveResourceKey>): boolean {
  return RESOURCE_KIND_TO_LIVE_KEYS[kind].some((key) => keys.has(key));
}

function hrefMatchesAnyLiveResourceKey(href: string, keys: ReadonlySet<LiveResourceKey>): boolean {
  return liveResourceKeysForHref(href).some((key) => keys.has(key));
}

function shouldBroadlyInvalidateRealtimeEvent(event: RealtimeProjectionEvent): boolean {
  return isMissedEventsRecovery(event) && !hasRealtimeRoutingHints(event);
}

function hasRealtimeRoutingHints(event: RealtimeProjectionEvent): boolean {
  return event.resources.length > 0 || event.recovery.endpoints.length > 0 || projectionResourceKindsForEvent(event).length > 0;
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

function recordLiveResourceRevisions(revisions: LiveResourceRevisionMap, keys: readonly LiveResourceKey[], revision: number): void {
  for (const key of new Set(keys)) {
    revisions[key] = Math.max(revisions[key] ?? revision, revision);
  }
}

function isNewerProjectionRevision(revision: number, currentRevision: number | null): boolean {
  return currentRevision === null || revision > currentRevision;
}

function isMissedEventsRecovery(event: RealtimeProjectionEvent): boolean {
  return event.missedEvents || event.recovery.reason === "missed-events";
}

function projectionResourceKindsForEvent(event: RealtimeProjectionEvent): readonly RealtimeResourceKind[] {
  if (event.type !== "projection.updated") return [];
  const payload = event.payload as {
    resourceKinds?: readonly RealtimeResourceKind[];
    resourcesChanged?: readonly RealtimeResourceKind[];
  };
  return payload.resourcesChanged ?? payload.resourceKinds ?? [];
}

function usesProjectionResourceChanges(event: RealtimeProjectionEvent): boolean {
  if (event.type !== "projection.updated") return false;
  const payload = event.payload as { resourcesChanged?: readonly RealtimeResourceKind[] };
  return Array.isArray(payload.resourcesChanged);
}

function addLiveResourceKeysForResource(keys: Set<LiveResourceKey>, resource: RealtimeProjectionResource): void {
  addLiveResourceKeysForKind(keys, resource.kind);
  addLiveResourceKeysForHref(keys, resource.href);
}

function addLiveResourceKeysForKind(keys: Set<LiveResourceKey>, kind: RealtimeResourceKind): void {
  for (const key of RESOURCE_KIND_TO_LIVE_KEYS[kind]) keys.add(key);
}

function addLiveResourceKeysForHref(keys: Set<LiveResourceKey>, href: string): void {
  for (const key of liveResourceKeysForHref(href)) keys.add(key);
}

function liveResourceKeysForHref(href: string): readonly LiveResourceKey[] {
  const keys = new Set<LiveResourceKey>();
  const pathname = normalizeRealtimeHrefPath(href);
  if (!pathname) return [];
  for (const matcher of LIVE_RESOURCE_PATH_MATCHERS) {
    if (matcher.matches(pathname)) keys.add(matcher.key);
  }
  return [...keys];
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
