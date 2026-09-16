import { configSchema, type Config } from '../src/config/schema.ts'
import type { Client, OpenAIResponse } from '../src/agent/client.ts'

export function cfg(over: Partial<Config> = {}): Config {
  // verbose is CLI-only and not part of configSchema, so peel it off before
  // parsing and re-attach it (default false), mirroring buildConfig.
  const { verbose = false, ...rest } = over
  return { ...configSchema.parse(rest), verbose }
}

// Mirrors the real Responses API's invariant that `output_text` is derived
// from a `message` item in `output` — runAgent now replays `output` directly
// (via the SDK's toResponseInputItems) instead of separately reconstructing
// an assistant message from `output_text`, so a fake whose `output` doesn't
// actually contain the text would silently lose it from history.
export function messageItem(text: string): unknown {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

export function fakeClient(
  text: string,
  split = false,
  output?: unknown[],
  // Real usage (input/output token counts) for tests that need
  // response.usage populated — omitted by default, matching most fakes'
  // OpenAI-compatible endpoints, which don't always report it either.
  usage?: { input: number; output: number },
): Client {
  const resolvedOutput = output ?? (text ? [messageItem(text)] : [])
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
          ({
            output: resolvedOutput,
            output_text: text,
            ...(usage && {
              usage: {
                input_tokens: usage.input,
                output_tokens: usage.output,
              },
            }),
          }) as unknown as OpenAIResponse,
      }
    },
  }
}

export function makeSink() {
  const out: string[] = []
  return { sink: { write: (t: string) => void out.push(t) }, out }
}
