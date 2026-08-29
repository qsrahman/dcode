import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { ToolContext } from '../../agent/types.ts'

// --- SSRF guard --------------------------------------------------------------
//
// Reject loopback/private/link-local/cloud-metadata addresses before
// connecting. Opt-in (see FetchOpts.checkHost below): only meaningful for a
// caller whose target URL isn't fully within dcode's own control — a
// model-chosen URL (web_fetch), sometimes sourced from content read
// elsewhere (search results, a previously-fetched page) rather than the user
// directly, is a narrower, easier-to-steer-into target than a fixed,
// hardcoded API endpoint (web_search's Brave endpoint), which doesn't need
// this check at all.
//
// This is a resolve-then-check guard, not connection-level pinning: fetch()
// re-resolves the hostname itself after assertPublicHost approves it, so a
// host whose DNS record changes between the check and the actual connection
// (DNS rebinding) could still slip through. That residual gap is accepted —
// closing it fully would need a custom connect-time hook that Node's global
// fetch doesn't expose without extra dependencies — but this still blocks
// the overwhelmingly common cases: a literal internal/metadata IP, a bare
// `localhost`/private hostname, or a redirect to one.
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8 ("this" network)
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 carrier-grade NAT
  if (a >= 224) return true // multicast/reserved
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true // fc00::/7 unique local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) // IPv4-mapped IPv6
  if (mapped) return isPrivateIPv4(mapped[1]!)
  return false
}

function isPrivateIP(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateIPv4(ip)
  if (version === 6) return isPrivateIPv6(ip)
  return true // not a recognizable literal IP; treat as unsafe
}

export async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new Error(
        `refusing to fetch a private/internal address: ${hostname}`,
      )
    }
    return
  }
  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new Error(`could not resolve host: ${hostname}`)
  }
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error(
        `refusing to fetch ${hostname}: resolves to a private/internal address (${address})`,
      )
    }
  }
}

// --- Shared fetch wrapper ----------------------------------------------------

export interface FetchOpts {
  // See the SSRF guard note above — only web_fetch (an untrusted, often
  // model-chosen target) opts into this; web_search's fixed Brave endpoint
  // doesn't need it.
  checkHost?: boolean
}

const MAX_REDIRECTS = 5

// Every tool that hits the network goes through this: bounds the request
// with ctx.config.toolTimeout (combined with ctx.signal via AbortSignal.any)
// so a hung request is actually cancelled rather than left running after
// runTool gives up on it — the same resource-cancellation discipline
// tools/local/exec.ts's execa calls already have — and follows redirects
// manually (not fetch's default 'follow') so that, when checkHost is on,
// every hop is re-validated, not just the first URL.
export async function fetchSafely(
  url: URL,
  init: RequestInit,
  ctx: ToolContext,
  opts: FetchOpts = {},
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ctx.config.toolTimeout)
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, timeoutSignal])
    : timeoutSignal
  let current = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (opts.checkHost) await assertPublicHost(current.hostname)
    const res = await fetch(current, { ...init, signal, redirect: 'manual' })
    if (
      [301, 302, 303, 307, 308].includes(res.status) &&
      res.headers.get('location')
    ) {
      const next = new URL(res.headers.get('location')!, current)
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`redirect to unsupported scheme: ${next.protocol}`)
      }
      current = next
      continue
    }
    return res
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
}

// Cap how much of a response body is read into memory. Reads the stream
// directly rather than res.text() so an oversized body is cut off during
// download instead of buffered in full before being discarded.
export async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { text: await res.text(), truncated: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.length - (total - maxBytes)))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  return { text, truncated }
}
