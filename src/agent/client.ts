import OpenAI from 'openai'
import type { AppConfig } from '../config/schema.ts'

// Structural subset of the SDK's ResponseInput; `{role, content}` messages are
// assignable to it, so we avoid a deep type import while staying compatible.
export type InputItem = Array<{
  role: 'user' | 'system' | 'developer'
  content: string
}>

export interface Client {
  complete(input: InputItem, opts?: { signal?: AbortSignal }): Promise<string>
  stream(
    input: InputItem,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string>
}

// Thin wrapper over the OpenAI Responses SDK. Dependencies are constructed here
// so the rest of the app can depend on the Client interface and stay
// testable without network access.
export function createClient(config: AppConfig): Client {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  return {
    async complete(input, opts) {
      const response = await client.responses.create(
        { model: config.model, input, stream: false },
        { signal: opts?.signal },
      )
      return response.output_text
    },
    async *stream(input, opts) {
      const stream = client.responses.stream(
        { model: config.model, input },
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
