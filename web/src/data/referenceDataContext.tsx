import { createContext, useContext, type ReactNode } from "react";
import type { ReferenceData } from "../types/symphony";

const fallbackReferenceData: ReferenceData = {
  users: {},
  labels: {},
};

const ReferenceDataContext = createContext<ReferenceData>(fallbackReferenceData);

export function ReferenceDataProvider({
  value,
  children,
}: {
  value: ReferenceData;
  children: ReactNode;
}) {
  return <ReferenceDataContext.Provider value={value}>{children}</ReferenceDataContext.Provider>;
}

export function useReferenceData(): ReferenceData {
  return useContext(ReferenceDataContext);
}
