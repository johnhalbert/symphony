import { useEffect, useState } from "react";
import type { Loadable } from "../types/symphony";

export function useAsyncResource<T>(load: () => Promise<T>, deps: readonly unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    let active = true;
    setState((current) => ({ data: current.data, loading: true, error: null }));
    load()
      .then((data) => {
        if (active) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ data: null, loading: false, error: message });
      });
    return () => {
      active = false;
    };
    // The caller owns dependency stability; this keeps the hook small and explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
