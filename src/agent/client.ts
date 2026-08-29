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
      // Explicit, unconditional: `store` is always exactly `config.stateful`
      // (default false, so no server-side 30-day retention on real OpenAI
      // unless the user opts in). Earlier this branched on whether the
      // configured endpoint "looked like" OpenAI, omitting the param
      // entirely for anything else on the guess that non-OpenAI endpoints
      // might reject an unrecognized field — an assumption about endpoint
      // behavior dcode has no way to actually verify, and one this project's
      // own testing (a real Ollama /v1/responses endpoint) showed to be
      // unnecessary: it accepts an explicit `store` field fine. If some
      // stricter endpoint ever does reject it, that surfaces as a clear API
      // error the user can act on — not a silent guess either way.
      params.store = config.stateful
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
