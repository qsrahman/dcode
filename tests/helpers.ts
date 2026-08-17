import { appConfigSchema, type AppConfig } from '../src/config/schema.ts'
import type { Client } from '../src/agent/client.ts'

export function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return appConfigSchema.parse(over)
}

export function fakeClient(text: string, split = false): Client {
  return {
    async *stream() {
      if (split) {
        yield text.slice(0, 5)
        yield text.slice(5)
      } else {
        yield text
      }
    },
  }
}

export function makeSink() {
  const out: string[] = []
  return { sink: { write: (t: string) => void out.push(t) }, out }
}
