import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { z } from 'zod'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'

const htmlMarkdown = new NodeHtmlMarkdown()

// Convert an HTML document to Markdown (headings, links, code blocks). Kept as a
// separate, exported helper so it can be unit-tested without a network fetch.
export function htmlToMarkdown(html: string): string {
  return htmlMarkdown.translate(html).trim()
}

const BRAVE_ENDPOINT =
  process.env.BRAVE_ENDPOINT ?? 'https://api.search.brave.com/res/v1/web/search'

interface BraveResult {
  title: string
  url: string
  description: string
}

// --- SSRF guard for web_fetch ------------------------------------------------
//
// web_fetch takes a URL the model chooses — sometimes from content it read
// elsewhere (search results, a previously-fetched page) rather than the user
// directly — so it's a narrower, easier-to-steer-into target than run_shell
// (which requires the model to construct and the user to have implicitly
// accepted as full shell access). Reject loopback/private/link-local/
// cloud-metadata addresses before connecting.
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

async function assertPublicHost(hostname: string): Promise<void> {
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

const MAX_REDIRECTS = 5

// Fetch with redirects followed manually (not the default `redirect:
// 'follow'`) so every hop — not just the original URL — is re-validated by
// assertPublicHost before being requested. Also wires a combined signal
// (ctx.signal + the tool's own timeout) so a hung request is actually
// cancelled rather than left running after runTool gives up on it.
async function safeFetch(
  url: URL,
  init: RequestInit,
  ctx: ToolContext,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ctx.config.toolTimeout)
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, timeoutSignal])
    : timeoutSignal
  let current = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(current.hostname)
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

// Cap how much of a response body is read into memory. Mirrors grep's
// GREP_MAX_FILE_SIZE — large enough for real pages/docs, small enough that a
// multi-gigabyte response can't be pulled fully into the process. Reads the
// stream directly rather than res.text() so an oversized body is cut off
// instead of buffered in full before being discarded.
const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024

async function readBounded(
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

// Web search via the Brave Search API. The key is read from BRAVE_API_KEY at
// call time so tool construction stays config-free; a missing key (or any API
// failure) throws, which runTool feeds back to the model as an ok:false
// outcome (decision D) — the same path every other tool uses.
function webSearchTool(): ToolDefinition<{ query: string; count?: number }> {
  return {
    name: 'web_search',
    description:
      'Search the web for a query and return the top results (title, URL, snippet). Use for current information, library or API docs, or anything not found in the working directory.',
    parameters: z.object({
      query: z.string().describe('Search query'),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of results to return (default 5)'),
    }),
    async execute(args, ctx) {
      // ctx.config.brave is the single source of truth: buildConfig already
      // resolves BRAVE_API_KEY (env) over the stored config file into it, so
      // reading process.env here too would just re-derive the same value (or,
      // if they ever diverge, wrongly prefer the stale env over a key set at
      // runtime via `/key set brave`).
      const key = ctx.config.brave
      if (!key) {
        throw new Error(
          'BRAVE_API_KEY is not set; cannot search the web (store it with: /key set brave <key>)',
        )
      }
      const url = new URL(BRAVE_ENDPOINT)
      url.searchParams.set('q', args.query)
      url.searchParams.set('count', String(args.count ?? 5))
      url.searchParams.set('text_decorations', 'false')
      let res: Response
      try {
        res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': key,
          },
          signal: ctx.signal,
        })
      } catch (err) {
        throw new Error(
          `web search request failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!res.ok) {
        throw new Error(`Brave API returned ${res.status}`)
      }
      const data = (await res.json()) as { web?: { results?: BraveResult[] } }
      const results = data.web?.results ?? []
      if (results.length === 0) return '(no results)'
      return results
        .map((r) => `${r.title}\n${r.url}\n${r.description}`)
        .join('\n\n')
    },
  }
}

// Fetch a URL and return its content as text. HTML is converted to Markdown,
// JSON is pretty-printed, other text is passed through, and binary payloads
// are described rather than dumped. No API key is needed — dcode fetches
// directly from the machine's network. Errors (bad scheme, non-2xx, network
// failure) are thrown and the runner returns them to the model as ok:false.
export function webFetchTool(): ToolDefinition<{ url: string }> {
  return {
    name: 'web_fetch',
    description:
      "Fetch a URL and return its content as text. HTML pages are converted to Markdown; JSON is pretty-printed; other text is returned as-is. Use to read a specific page, doc, or API response when you already know the URL. Use web_search to discover URLs you don't know yet. Requests to private/internal/loopback addresses are refused.",
    parameters: z.object({
      url: z.string().describe('Absolute http(s) URL to fetch'),
    }),
    async execute(args, ctx) {
      let target: URL
      try {
        target = new URL(args.url)
      } catch {
        throw new Error(`invalid URL: ${args.url}`)
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(
          `unsupported scheme (${target.protocol}); only http(s) is allowed`,
        )
      }
      let res: Response
      try {
        res = await safeFetch(
          target,
          { headers: { 'User-Agent': 'dcode' } },
          ctx,
        )
      } catch (err) {
        throw new Error(
          `web fetch request failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!res.ok) {
        throw new Error(`web fetch failed: HTTP ${res.status}`)
      }
      const contentType = (
        res.headers.get('content-type') ?? 'text/plain'
      ).toLowerCase()
      // Binary payloads are described from headers alone — never buffered.
      if (!contentType.startsWith('text/') && !contentType.includes('json')) {
        const len = res.headers.get('content-length')
        return `(binary ${contentType}${len ? `, ${len} bytes` : ''}; not shown)`
      }
      const { text, truncated } = await readBounded(res, WEB_FETCH_MAX_BYTES)
      const suffix = truncated
        ? `\n… [response truncated at ${WEB_FETCH_MAX_BYTES} bytes]`
        : ''
      if (contentType.startsWith('text/html')) {
        return htmlToMarkdown(text) + suffix
      }
      if (contentType.includes('json')) {
        try {
          return JSON.stringify(JSON.parse(text), null, 2) + suffix
        } catch {
          return text + suffix
        }
      }
      return text + suffix
    },
  }
}

export const webTools: ToolDefinition[] = [webSearchTool(), webFetchTool()]
