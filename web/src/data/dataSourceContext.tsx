import { createContext, useContext, type ReactNode } from "react";
import type { SymphonyDataSource } from "./dataSource";
import { createDataSource, resolveDataSourceConfig } from "./dataSourceConfig";

const dataSourceConfig = resolveDataSourceConfig(import.meta.env);

export const defaultDataSource: SymphonyDataSource = createDataSource(dataSourceConfig);

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
