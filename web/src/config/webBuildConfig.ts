export type ViteCommand = "build" | "serve";

export interface WebBasePathEnv {
  SYMPHONY_WEB_BASE_PATH?: string;
  VITE_SYMPHONY_WEB_BASE_PATH?: string;
}

export interface WebBasePathContext {
  command: ViteCommand;
  mode: string;
}

const DEFAULT_PRODUCTION_BASE_PATH = "/web/";
const DEFAULT_DEVELOPMENT_BASE_PATH = "/";

function firstNonBlank(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/") return "/";
  if (trimmed === "." || trimmed === "./") return "./";

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function resolveWebBasePath(env: WebBasePathEnv, context: WebBasePathContext): string {
  const configuredBasePath = firstNonBlank([env.SYMPHONY_WEB_BASE_PATH, env.VITE_SYMPHONY_WEB_BASE_PATH]);
  if (configuredBasePath) return normalizeBasePath(configuredBasePath);

  return context.command === "build" || context.mode === "production" ? DEFAULT_PRODUCTION_BASE_PATH : DEFAULT_DEVELOPMENT_BASE_PATH;
}
