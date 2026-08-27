import { configSchema, type Config } from '../src/config/schema.ts'
import type { Client, OpenAIResponse } from '../src/agent/client.ts'

export function cfg(over: Partial<Config> = {}): Config {
  return configSchema.parse(over)
}

export function fakeClient(
  text: string,
  split = false,
  output: unknown[] = [],
): Client {
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          if (split) {
            yield text.slice(0, 5)
            yield text.slice(5)
          } else {
            yield text
          }
        },
        finalResponse: async () =>
          ({ output, output_text: text }) as unknown as OpenAIResponse,
        abort: () => {},
      }
    },
  }
}

export function makeSink() {
  const out: string[] = []
  return { sink: { write: (t: string) => void out.push(t) }, out }
}
