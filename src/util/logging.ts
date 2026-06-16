const TELEGRAM_BOT_TOKEN_PATTERN = /bot\d+:[A-Za-z0-9_-]+/g;

export function redactSecrets(value: unknown): string {
  const text = value instanceof Error
    ? value.stack || value.message
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  return (text || String(value)).replace(TELEGRAM_BOT_TOKEN_PATTERN, "bot<redacted>");
}

export function logError(label: string, error: unknown): void {
  console.error(label, redactSecrets(error));
}
