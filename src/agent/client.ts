import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseInput,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses'
import type { Config } from '../config/schema.ts'

export type { ResponseInput, OpenAIResponse }

export interface ModelStream extends AsyncIterable<string> {
  finalResponse(): Promise<OpenAIResponse>
}

export interface Client {
  stream(
    input: ResponseInput,
    opts?: {
      tools?: ResponsesTool[]
      maxOutputTokens?: number
      instructions?: string
      signal?: AbortSignal
    },
  ): ModelStream
}

// True when a request failed because the input exceeded the model's context
// window. Drives the loop's compact-and-retry recovery. Matches OpenAI's 413
// status and its `context_length_exceeded` error type / message wording.
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 413) return true
    if (err.code === 'context_length_exceeded') return true
    if (
      /context.length.exceeded|maximum context length|token limit|context window/i.test(
        err.message,
      )
    ) {
      return true
    }
  }
  return false
}

// True when the request actually goes to OpenAI's own API — either no
// baseURL override (the SDK's own default) or one explicitly pointed at
// api.openai.com. An unparsable baseURL is treated as "not OpenAI" (same as
// any other custom endpoint) rather than throwing.
function isRealOpenAI(baseURL: string | undefined): boolean {
  if (!baseURL) return true
  try {
    return new URL(baseURL).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

// Thin wrapper over the OpenAI Responses SDK. Dependencies are constructed here
// so the rest of the app can depend on the Client interface and stay
// testable without network access.
export function createClient(config: Config): Client {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: config.maxRetries,
  })

  return {
    stream(input, opts) {
      const params: ResponseCreateParamsStreaming = {
        model: config.model,
        input,
        max_output_tokens: opts?.maxOutputTokens ?? config.maxTokens,
        stream: true,
      }
      if (opts?.tools) params.tools = opts.tools
      if (opts?.instructions) params.instructions = opts.instructions
      // Default to no server-side storage against real OpenAI: avoids its
      // 30-day retention. `isRealOpenAI` — not merely "no baseURL configured"
      // — matters because a user can point `baseURL` explicitly at
      // api.openai.com (e.g. to pin an API version); keying off "baseURL is
      // set" alone would silently omit `store` for that case too, letting
      // OpenAI's server-side default (store: true) apply unintentionally.
      // Other custom/local endpoints omit the param entirely (many don't
      // support it) unless statefulness is explicitly requested.
      if (config.stateful) params.store = true
      else if (isRealOpenAI(config.baseURL)) params.store = false
      // Passing signal here (rather than a separate abort() method callers
      // have to remember to invoke) lets the SDK's own EventStream wire it
      // into its internal AbortController, so cancelling the turn's
      // AbortSignal cancels the HTTP request too — no extra plumbing needed.
      const s = client.responses.stream(params, { signal: opts?.signal })
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of s) {
            if (event.type === 'response.output_text.delta') {
              yield event.delta
            }
          }
        },
        finalResponse: () => s.finalResponse(),
      }
    },
  }
}
