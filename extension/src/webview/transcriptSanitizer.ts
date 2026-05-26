const REDACTED = "[redacted]";
const TOKEN_PREFIX_PATTERN = /\b(?:ghp_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "secret",
  "password",
  "accesstoken",
  "refreshtoken",
  "githubtoken",
  "clientsecret",
  "privatekey",
]);
const SAFE_NORMALIZED_KEYS = new Set(["tokens", "inputtokens", "outputtokens", "totaltokens", "tokenconfigured"]);

export function sanitizeTranscriptPreview(value: string): string {
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, REDACTED)
    .replace(/\bBearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`)
    .replace(TOKEN_PREFIX_PATTERN, REDACTED)
    .replace(/(\b([A-Za-z][A-Za-z0-9_-]*)\b\s*=\s*)([^\s"',}]+)/g, (match: string, prefix: string, label: string) =>
      isSensitiveKey(label) ? `${prefix}${REDACTED}` : match,
    )
    .replace(
      /((?:"([A-Za-z][A-Za-z0-9_-]*)"|([A-Za-z][A-Za-z0-9_-]*))\s*:\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/g,
      (match: string, prefix: string, quotedLabel: string | undefined, bareLabel: string | undefined) =>
        isSensitiveKey(quotedLabel ?? bareLabel ?? "") ? `${prefix}"${REDACTED}"` : match,
    );
}

function normalizeSensitiveLabel(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeSensitiveLabel(key);
  if (SAFE_NORMALIZED_KEYS.has(normalized)) return false;
  if (SENSITIVE_NORMALIZED_KEYS.has(normalized)) return true;
  return (
    (normalized.endsWith("token") && !normalized.endsWith("tokens")) ||
    normalized.endsWith("secret") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("apikey")
  );
}
