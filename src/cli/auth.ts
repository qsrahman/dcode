import type { Config } from '../config/schema.ts'
import { normalizeBaseURL } from '../config/config.ts'

// Cheap liveness/auth check: a single models listing with the configured key.
// Only an auth rejection (401/403) is treated as an invalid key; any other
// outcome (unknown endpoint, network error, rate limit) is treated as "don't
// block startup" so dcode still runs against endpoints that don't expose
// /models or don't require a key.
export async function validateApiKey(config: Config): Promise<boolean> {
  const base = normalizeBaseURL(config.baseURL ?? 'https://api.openai.com')
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    })
    return res.status !== 401 && res.status !== 403
  } catch {
    return true
  }
}
