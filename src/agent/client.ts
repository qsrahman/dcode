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
  stream(input: ResponseInput, opts?: { tools?: ResponsesTool[] }): ModelStream
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
        max_output_tokens: config.maxTokens,
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
