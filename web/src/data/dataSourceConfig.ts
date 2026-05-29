import type { SymphonyDataSource } from "./dataSource";
import { mockDataSource } from "./mockDataSource";
import { createApiDataSource } from "./apiDataSource";

export type DataSourceMode = "mock" | "api";

export interface DataSourceEnv {
  VITE_SYMPHONY_DATA_SOURCE?: string;
  VITE_SYMPHONY_API_BASE_URL?: string;
}

export interface DataSourceConfig {
  mode: DataSourceMode;
  apiBaseUrl: string;
}

function normalizeMode(value: string | undefined): DataSourceMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "api") return "api";
  if (normalized === "mock" || normalized === "demo" || normalized === "local") return "mock";
  return null;
}

export function resolveDataSourceConfig(env: DataSourceEnv): DataSourceConfig {
  const apiBaseUrl = env.VITE_SYMPHONY_API_BASE_URL?.trim() ?? "";
  const explicitMode = normalizeMode(env.VITE_SYMPHONY_DATA_SOURCE);

  if (explicitMode) {
    return { mode: explicitMode, apiBaseUrl };
  }

  return {
    mode: apiBaseUrl ? "api" : "mock",
    apiBaseUrl,
  };
}

export function createDataSource(config: DataSourceConfig): SymphonyDataSource {
  return config.mode === "api" ? createApiDataSource(config.apiBaseUrl) : mockDataSource;
}
