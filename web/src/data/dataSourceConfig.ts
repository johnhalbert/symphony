import type { SymphonyDataSource } from "./dataSource";
import { createApiDataSource } from "./apiDataSource";

export type DataSourceMode = "mock" | "api";

export interface DataSourceEnv {
  VITE_SYMPHONY_DATA_SOURCE?: string;
  VITE_SYMPHONY_API_BASE_URL?: string;
  MODE?: string;
  PROD?: boolean;
}

export interface DataSourceConfig {
  mode: DataSourceMode;
  apiBaseUrl: string;
}

export interface DataSourceFactoryOptions {
  loadMockDataSource?: () => Promise<SymphonyDataSource>;
}

function normalizeMode(value: string | undefined): DataSourceMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "api") return "api";
  if (normalized === "mock" || normalized === "demo" || normalized === "local") return "mock";
  return null;
}

function isProductionBuild(env: DataSourceEnv): boolean {
  return env.PROD === true || env.MODE?.trim().toLowerCase() === "production";
}

export function resolveDataSourceConfig(env: DataSourceEnv): DataSourceConfig {
  const apiBaseUrl = env.VITE_SYMPHONY_API_BASE_URL?.trim() ?? "";
  const explicitMode = normalizeMode(env.VITE_SYMPHONY_DATA_SOURCE);

  return {
    mode: explicitMode === "mock" && isProductionBuild(env) ? "api" : (explicitMode ?? "api"),
    apiBaseUrl,
  };
}

export function createDataSource(config: DataSourceConfig, options: DataSourceFactoryOptions = {}): SymphonyDataSource {
  return config.mode === "api" ? createApiDataSource(config.apiBaseUrl) : createLazyMockDataSource(options.loadMockDataSource);
}

let defaultMockDataSourcePromise: Promise<SymphonyDataSource> | null = null;

function loadDefaultMockDataSource(): Promise<SymphonyDataSource> {
  if (import.meta.env.PROD) {
    return Promise.reject(new Error("Mock dashboard data is not bundled in production builds; use API mode or a non-production demo build."));
  }
  defaultMockDataSourcePromise ??= import("./mockDataSource").then(({ mockDataSource }) => mockDataSource);
  return defaultMockDataSourcePromise;
}

function createLazyMockDataSource(loadMockDataSource: DataSourceFactoryOptions["loadMockDataSource"]): SymphonyDataSource {
  const load = loadMockDataSource ?? loadDefaultMockDataSource;
  let dataSourcePromise: Promise<SymphonyDataSource> | null = null;
  const dataSource = () => {
    dataSourcePromise ??= load();
    return dataSourcePromise;
  };

  return {
    async getReferenceData(signal) {
      return (await dataSource()).getReferenceData(signal);
    },
    async getDashboard(signal) {
      return (await dataSource()).getDashboard(signal);
    },
    async getIssueBoard(signal) {
      return (await dataSource()).getIssueBoard(signal);
    },
    async getIssueDetail(issueId, signal) {
      return (await dataSource()).getIssueDetail(issueId, signal);
    },
    async getHistory(signal) {
      return (await dataSource()).getHistory(signal);
    },
    async getSessions(signal) {
      return (await dataSource()).getSessions(signal);
    },
    async getTranscript(sessionId, signal) {
      return (await dataSource()).getTranscript(sessionId, signal);
    },
    async getSidebar(signal) {
      return (await dataSource()).getSidebar(signal);
    },
    async getOrchestratorChat(signal) {
      return (await dataSource()).getOrchestratorChat(signal);
    },
    async sendOrchestratorMessage(input) {
      return (await dataSource()).sendOrchestratorMessage(input);
    },
    async triggerPoll() {
      const loaded = await dataSource();
      if (!loaded.triggerPoll) throw new Error("Trigger poll is unavailable for this data source.");
      return loaded.triggerPoll();
    },
  };
}
