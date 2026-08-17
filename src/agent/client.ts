import OpenAI from 'openai'
import type { ResponseInput } from 'openai/resources/responses/responses'
import type { AppConfig } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'

export type { ResponseInput }

export interface Client {
  stream(
    input: ResponseInput,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string>
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
    async *stream(input, opts) {
      logger.debug('stream request model=%s', config.model)
      const stream = client.responses.stream(
        { model: config.model, input, max_output_tokens: config.maxTokens },
        { signal: opts?.signal },
      )
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          yield event.delta
        }
      }
    },
  }
}
