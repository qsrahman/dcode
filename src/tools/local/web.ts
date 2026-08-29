import { z } from 'zod'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import type { ToolDefinition } from '../../agent/types.ts'
import { fetchSafely, readBounded } from './http.ts'

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

// Cap how much of a fetched page is read into memory — see http.ts's
// readBounded. Large enough for real pages/docs, small enough that a
// multi-gigabyte response can't be pulled fully into the process.
const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024

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
        // checkHost omitted (defaults false): BRAVE_ENDPOINT is a fixed,
        // hardcoded constant, not user/model-controlled input, so the SSRF
        // guard has nothing to protect against here.
        res = await fetchSafely(
          url,
          {
            headers: {
              Accept: 'application/json',
              'X-Subscription-Token': key,
            },
          },
          ctx,
        )
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
        res = await fetchSafely(
          target,
          { headers: { 'User-Agent': 'dcode' } },
          ctx,
          { checkHost: true },
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
