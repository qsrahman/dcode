import type { Client, InputItem } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import { buildSystemPrompt } from './system.ts'

export interface RunSink {
  write(text: string): void
}

// One-shot orchestration: send a single user turn and emit the model output.
// `stream` writes deltas as they arrive; `complete` writes the full text once.
// Returns the full text so callers (REPL later) can capture it.
export async function runOneShot(
  client: Client,
  config: AppConfig,
  prompt: string,
  sink: RunSink = process.stdout,
): Promise<string> {
  const input: InputItem = [
    { role: 'system', content: buildSystemPrompt(config) },
    { role: 'user', content: prompt },
  ]
  if (config.stream) {
    let full = ''
    for await (const delta of client.stream(input)) {
      full += delta
      sink.write(delta)
    }
    sink.write('\n')
    return full
  }
  const text = await client.complete(input)
  sink.write(text + '\n')
  return text
}
