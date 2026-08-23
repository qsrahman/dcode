import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseInput,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses'
import type { AppConfig } from '../config/schema.ts'

export type { ResponseInput, OpenAIResponse }

export interface ModelStream extends AsyncIterable<string> {
  finalResponse(): Promise<OpenAIResponse>
  abort(): void
}

export interface Client {
  stream(
    input: ResponseInput,
    opts?: { tools?: ResponsesTool[]; maxOutputTokens?: number },
  ): ModelStream
}

// True when a request failed because the input exceeded the model's context
// window. Drives the loop's compact-and-retry recovery. Matches OpenAI's 413
// status and its `context_length_exceeded` error type / message wording.
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 413) return true
    const code = (err as { code?: string }).code
    if (code === 'context_length_exceeded') return true
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
export function createClient(config: AppConfig): Client {
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
      const s = client.responses.stream(params)
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of s) {
            if (event.type === 'response.output_text.delta') {
              yield event.delta
            }
          }
        },
        finalResponse: () => s.finalResponse(),
        abort: () => s.abort(),
      }
    },
  }
}
