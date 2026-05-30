import { useEffect, useState } from "react";
import type { Loadable } from "../types/symphony";

interface AsyncResourceState<T> extends Loadable<T> {
  enabled: boolean;
}

export interface AsyncResourceOptions {
  enabled?: boolean;
}

export function useAsyncResource<T>(
  load: (signal?: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: AsyncResourceOptions = {},
): Loadable<T> {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<AsyncResourceState<T>>({ data: null, loading: enabled, error: null, enabled });

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setState((current) => ({ data: current.data, loading: false, error: null, enabled: false }));
      return () => {
        active = false;
      };
    }

    const controller = new AbortController();
    setState((current) => ({ data: current.data, loading: true, error: null, enabled: true }));
    load(controller.signal)
      .then((data) => {
        if (active) setState({ data, loading: false, error: null, enabled: true });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ data: null, loading: false, error: message, enabled: true });
      });
    return () => {
      active = false;
      controller.abort();
    };
    // The caller owns dependency stability; this keeps the hook small and explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  if (enabled && !state.enabled) return { data: state.data, loading: true, error: null };
  return { data: state.data, loading: state.loading, error: state.error };
}
