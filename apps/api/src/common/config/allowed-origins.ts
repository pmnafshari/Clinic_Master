const DEFAULT_ORIGIN = 'http://localhost:3000';

/**
 * One allowlist for both HTTP CORS and the WebSocket upgrade.
 *
 * CORS does not apply to WebSocket handshakes, so the gateway has to check
 * Origin itself. Reading the same env var through the same helper is what stops
 * the two lists drifting apart — a socket that accepts an origin CORS rejects
 * is a hole with no obvious owner.
 *
 * Read fresh on every call rather than captured at import: a module-level
 * snapshot would bake in whatever the environment looked like when the first
 * import happened, which is a surprise in tests and in any process that loads
 * config after boot.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.FRONTEND_URL;
  if (!raw || raw.trim() === '') {
    return [DEFAULT_ORIGIN];
  }

  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return parsed.length > 0 ? parsed : [DEFAULT_ORIGIN];
}

/**
 * Exact match only.
 *
 * Prefix, suffix and substring comparisons are the classic way an origin check
 * is bypassed: `https://good.example.com.attacker.test` starts with the
 * allowed value, and `startsWith` would wave it through.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }
  return allowedOrigins().includes(origin);
}
