import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseInput,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses'
import type { AppConfig } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'

export type { ResponseInput, OpenAIResponse }

export interface ModelStream extends AsyncIterable<string> {
  finalResponse(): Promise<OpenAIResponse>
}

export interface Client {
  stream(
    input: ResponseInput,
    opts?: { signal?: AbortSignal; tools?: ResponsesTool[] },
  ): ModelStream
}

// Thin wrapper over the OpenAI Responses SDK. Dependencies are constructed here
// so the rest of the app can depend on the Client interface and stay
// testable without network access.
export function createClient(config: AppConfig, logger: Logger): Client {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: config.maxRetries,
  })

  return {
    stream(input, opts) {
      logger.debug('stream request model=%s', config.model)
      const params: ResponseCreateParamsStreaming = {
        model: config.model,
        input,
        max_output_tokens: config.maxTokens,
        stream: true,
      }
      if (opts?.tools) params.tools = opts.tools
      const stream = client.responses.stream(params, { signal: opts?.signal })
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
              yield event.delta
            }
          }
        },
        finalResponse: () => stream.finalResponse(),
      }
    },
  }
}
