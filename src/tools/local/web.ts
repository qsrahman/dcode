import { z } from 'zod'
import type { ToolDefinition } from '../../agent/types.ts'

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResult {
  title: string
  url: string
  description: string
}

// Web search via the Brave Search API. The key is read from BRAVE_API_KEY at
// call time so tool construction stays config-free; a missing key (or any API
// failure) is returned to the model as a tool error (decision D) rather than
// crashing the agent.
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
    async execute(args) {
      const key = process.env.BRAVE_API_KEY
      if (!key) {
        return 'error: BRAVE_API_KEY is not set; cannot search the web'
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
        })
      } catch (err) {
        return `error: web search request failed: ${err instanceof Error ? err.message : String(err)}`
      }
      if (!res.ok) {
        return `error: Brave API returned ${res.status}`
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

export const webTools: ToolDefinition[] = [webSearchTool()]
