import type { Config } from '../config/schema.ts'
import { normalizeBaseURL } from '../config/config.ts'

// 'invalid' is the only outcome that blocks startup — a definite 401/403 auth
// rejection. 'valid' is a confirmed 2xx from the configured endpoint.
// 'unknown' covers everything else: a network error, a timeout, or any other
// status (a non-2xx-non-401/403, e.g. a 404 from an endpoint that doesn't
// expose /models, or a 429 rate limit) — none of these prove the key is
// wrong, but none confirm it's right either, so callers shouldn't treat it
// as verified (e.g. before persisting a freshly entered key).
export type ApiKeyStatus = 'valid' | 'invalid' | 'unknown'

// No real endpoint should take this long to answer a single /models list;
// bound it so a stalled network can't hang startup indefinitely.
const VALIDATE_TIMEOUT_MS = 10_000

// Cheap liveness/auth check: a single models listing with the configured key.
export async function validateApiKey(config: Config): Promise<ApiKeyStatus> {
  const base = normalizeBaseURL(config.baseURL ?? 'https://api.openai.com')
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) return 'invalid'
    return res.status >= 200 && res.status < 300 ? 'valid' : 'unknown'
  } catch {
    // Includes the AbortSignal.timeout firing — treated the same as any
    // other network failure: don't block startup, but don't call it verified.
    return 'unknown'
  }
}
