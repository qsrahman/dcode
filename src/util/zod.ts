import { z } from 'zod/v4'

// Shared http(s)-only URL validator. Four independent fields need exactly
// this check (parseable, and restricted to http/https) — config's baseURL,
// braveEndpoint, and mcpServers.<name>.url (config/schema.ts), and
// web_fetch's url parameter (tools/local/web.ts) — so it lives here once
// instead of four separately-written z.url({...}) calls that can silently
// drift (one previously had a custom error message the other three didn't).
export function httpUrl(message?: string) {
  return z.url({
    protocol: /^https?$/,
    ...(message ? { error: message } : {}),
  })
}
