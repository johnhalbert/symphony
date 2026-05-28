import { createContext, useContext, type ReactNode } from "react";
import { createApiDataSource } from "./apiDataSource";
import type { SymphonyDataSource } from "./dataSource";
import { mockDataSource } from "./mockDataSource";

const configuredApiBaseUrl = import.meta.env.VITE_SYMPHONY_API_BASE_URL as string | undefined;

export const defaultDataSource: SymphonyDataSource = configuredApiBaseUrl
  ? createApiDataSource(configuredApiBaseUrl)
  : mockDataSource;

const DataSourceContext = createContext<SymphonyDataSource>(defaultDataSource);

export function DataSourceProvider({
  value = defaultDataSource,
  children,
}: {
  value?: SymphonyDataSource;
  children: ReactNode;
}) {
  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): SymphonyDataSource {
  return useContext(DataSourceContext);
}
