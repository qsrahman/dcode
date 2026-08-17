import type { Client, ResponseInput } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import { buildSystemPrompt } from './system.ts'
import { createLogger, type Logger } from '../util/log.ts'

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
  logger: Logger = createLogger(config),
): Promise<string> {
  logger.debug('one-shot run start model=%s', config.model)
  const input: ResponseInput = [
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
