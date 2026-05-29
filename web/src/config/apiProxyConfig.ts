const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:7331";

function firstNonBlank(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function isHttpUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveApiProxyTarget(env: Record<string, string | undefined>): string {
  const configuredTarget = firstNonBlank([
    env.SYMPHONY_WEB_API_PROXY_TARGET,
    env.SYMPHONY_API_PROXY_TARGET,
    env.VITE_SYMPHONY_API_PROXY_TARGET,
    env.VITE_SYMPHONY_API_BASE_URL,
  ]);

  if (isHttpUrl(configuredTarget)) return configuredTarget.replace(/\/+$/, "");
  return DEFAULT_API_PROXY_TARGET;
}
