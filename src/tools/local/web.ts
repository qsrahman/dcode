import { z } from 'zod/v4'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { defineTool } from '../registry.ts'
import { fetchSafely, readBounded } from './http.ts'
import { errorMessage } from '../../util/log.ts'
import { httpUrl } from '../../config/schema.ts'

const htmlMarkdown = new NodeHtmlMarkdown()

// Convert an HTML document to Markdown (headings, links, code blocks). Kept as a
// separate, exported helper so it can be unit-tested without a network fetch.
export function htmlToMarkdown(html: string): string {
  return htmlMarkdown.translate(html).trim()
}

const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResult {
  title: string
  url: string
  description: string
}

// Cap how much of a fetched page is read into memory — see http.ts's
// readBounded. Large enough for real pages/docs, small enough that a
// multi-gigabyte response can't be pulled fully into the process.
const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
// Room kept under the output cap for the paging footer: runTool cuts anything
// past the cap from the end, which would be the footer.
const NOTE_RESERVE = 128

// Where a page starting at `start` ends: as many whole characters as fit in
// `maxBytes` of UTF-8. encodeInto stops before a character that doesn't fit, so
// a page never splits one. Offsets are UTF-16 code units, i.e. string indices.
function pageEnd(text: string, start: number, maxBytes: number): number {
  const { read } = new TextEncoder().encodeInto(
    text.slice(start, start + maxBytes),
    new Uint8Array(maxBytes),
  )
  return start + read
}

// Web search via the Brave Search API. The key is read from BRAVE_API_KEY at
// call time so tool construction stays config-free; a missing key (or any API
// failure) throws, which runTool feeds back to the model as an ok:false
// outcome (decision D) — the same path every other tool uses.
export const webSearchTool = () =>
  defineTool({
    name: 'web_search',
    category: 'web',
    description:
      'Search the web for a query and return the top results (title, URL, snippet); snippets only, so use web_fetch to read a result. Use for current information, library or API docs, or anything not found in the working directory. Needs a Brave Search API key; without one the call fails.',
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
      // ctx.config.braveApiKey is the single source of truth: buildConfig already
      // resolves BRAVE_API_KEY (env) over the stored config file into it, so
      // reading process.env here too would just re-derive the same value (or,
      // if they ever diverge, wrongly prefer the stale env over a key set at
      // runtime via `/key set brave`).
      const key = ctx.config.braveApiKey
      if (!key) {
        throw new Error(
          'BRAVE_API_KEY is not set; cannot search the web (store it with: /key set brave <key>)',
        )
      }
      const url = new URL(ctx.config.braveEndpoint ?? DEFAULT_BRAVE_ENDPOINT)
      url.searchParams.set('q', args.query)
      url.searchParams.set('count', String(args.count ?? 5))
      url.searchParams.set('text_decorations', 'false')
      let res: Response
      try {
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
        throw new Error(`web search request failed: ${errorMessage(err)}`)
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
  })

// The `format` the caller asks for. `markdown` (the default) converts HTML to
// Markdown and pretty-prints JSON so the model gets readable content; `text`
// and `html` return the body unconverted. The choice also drives the request's
// Accept header (see ACCEPT), so a server that content-negotiates can hand back
// a different representation per format — which is the real distinction between
// `text` and `html`, since dcode applies no conversion to either.
const ACCEPT: Record<'markdown' | 'text' | 'html', string> = {
  markdown: 'text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5',
  text: 'text/plain;q=1.0, */*;q=0.5',
  html: 'text/html;q=1.0, */*;q=0.5',
}

// Fetch a URL and return its content. No API key is needed — dcode fetches
// directly from the machine's network, with no host filtering (see http.ts):
// the target is reached as-is, private/loopback addresses included. Errors
// (bad scheme, non-2xx, network failure) are thrown and the runner returns
// them to the model as ok:false.
export const webFetchTool = () =>
  defineTool({
    name: 'web_fetch',
    category: 'web',
    description:
      "Fetch a URL and return its content. With format=markdown (default) HTML pages are converted to Markdown and JSON is pretty-printed; format=text or format=html return the body unconverted. Binary payloads are described, not dumped. Use to read a specific page, doc, or API response when you already know the URL; use web_search to discover URLs you don't know yet. Pages are not rendered (no JavaScript) and a non-2xx response is an error. A long page comes back in chunks of about 32 KiB, each ending with a note naming the offset to continue from; every call fetches the page again.",
    parameters: z.object({
      // httpUrl() validates both "is this a parseable URL" and
      // "is the scheme http(s)" in one check, so runTool's own
      // tool.parameters.parse(raw) call rejects a malformed or wrong-scheme
      // URL before execute() ever runs — no hand-rolled try/catch + scheme
      // check needed here.
      url: httpUrl('must be an absolute http(s) URL').describe(
        'Absolute http(s) URL to fetch',
      ),
      format: z
        .enum(['markdown', 'text', 'html'])
        .optional()
        .describe('How to return the content (default markdown)'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Characters of the content to skip, to read on from a "… offset=N to continue" note (default 0)',
        ),
    }),
    async execute(args, ctx) {
      // Schema validation already guarantees this parses and is http(s).
      const target = new URL(args.url)
      const format = args.format ?? 'markdown'
      let res: Response
      try {
        res = await fetchSafely(
          target,
          { headers: { 'User-Agent': 'dcode', Accept: ACCEPT[format] } },
          ctx,
        )
      } catch (err) {
        throw new Error(`web fetch request failed: ${errorMessage(err)}`)
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
      // Only markdown converts: HTML to Markdown, JSON pretty-printed. text and
      // html return the body as fetched.
      let body = text
      if (format === 'markdown') {
        if (contentType.startsWith('text/html')) {
          body = htmlToMarkdown(text)
        } else if (contentType.includes('json')) {
          try {
            body = JSON.stringify(JSON.parse(text), null, 2)
          } catch {
            // Not valid JSON after all; the raw text is still useful.
          }
        }
      }
      // Paging is over the converted content, so an offset from one call's
      // footer means the same thing in the next.
      const start = args.offset ?? 0
      if (start > 0 && start >= body.length) {
        throw new Error(
          `offset ${start} is past the end (${body.length} characters)`,
        )
      }
      const end = pageEnd(
        body,
        start,
        ctx.config.maxToolOutputBytes - NOTE_RESERVE,
      )
      const page = body.slice(start, end)
      if (end < body.length) {
        return `${page}\n… (characters ${start}–${end} of ${body.length}; offset=${end} to continue)`
      }
      // The download cap cut the source short: say so where the missing
      // content would have been, on the last page.
      return truncated
        ? `${page}\n… [response truncated at ${WEB_FETCH_MAX_BYTES} bytes]`
        : page
    },
  })
