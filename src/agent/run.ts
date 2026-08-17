import type { Client, ResponseInput } from './client.ts'
import type { AppConfig } from '../config/schema.ts'
import { buildSystemPrompt } from './system.ts'
import { createLogger, type Logger } from '../util/log.ts'

export interface RunSink {
  write(text: string): void
}

// Universal turn runner shared by one-shot and the REPL. Honors `config.stream`,
// writes output to `sink`, and forwards `signal` so callers (REPL) can abort an
// in-flight stream (decision L). Returns the full text.
export async function runTurn(
  client: Client,
  config: AppConfig,
  input: ResponseInput,
  sink: RunSink = process.stdout,
  logger: Logger = createLogger(config),
  signal?: AbortSignal,
): Promise<string> {
  logger.debug('run turn model=%s stream=%s', config.model, config.stream)
  if (config.stream) {
    let full = ''
    for await (const delta of client.stream(input, { signal })) {
      full += delta
      sink.write(delta)
    }
    sink.write('\n')
    return full
  }
  const text = await client.complete(input, { signal })
  sink.write(text + '\n')
  return text
}

// One-shot orchestration: a single user turn. Builds the input (system + user)
// and delegates to runTurn. Returns the full text so callers can capture it.
export async function runOneShot(
  client: Client,
  config: AppConfig,
  prompt: string,
  sink: RunSink = process.stdout,
  logger: Logger = createLogger(config),
): Promise<string> {
  const input: ResponseInput = [
    { role: 'system', content: buildSystemPrompt(config) },
    { role: 'user', content: prompt },
  ]
  return runTurn(client, config, input, sink, logger)
}
