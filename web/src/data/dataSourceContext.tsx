import { createContext, useContext, type ReactNode } from "react";
import type { SymphonyDataSource } from "./dataSource";
import { createDataSource, resolveDataSourceConfig } from "./dataSourceConfig";

export const defaultDataSourceConfig = resolveDataSourceConfig(import.meta.env);

export const defaultDataSource: SymphonyDataSource = createDataSource(defaultDataSourceConfig);

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
