import * as readline from 'node:readline'
import ansis from 'ansis'
import type { AppConfig } from '../config/schema.ts'
import { createClient } from '../agent/client.ts'
import type { ResponseInput } from '../agent/client.ts'
import { buildSystemPrompt } from '../agent/system.ts'
import { runAgent } from '../agent/loop.ts'
import { createLocalTools } from '../tools/index.ts'
import type { RunSink } from '../agent/run.ts'
import { type Logger, errorMessage } from '../util/log.ts'
import {
  type Session,
  type HandleResult,
  dispatch,
  parseCommand,
} from './commands.ts'

const HINT = '\nAsk anything, /help for commands...'
const PROMPT = ansis.cyan('> ')

export function createSession(config: AppConfig, logger: Logger): Session {
  return {
    config,
    logger,
    client: createClient(config, logger),
    history: [{ role: 'system', content: buildSystemPrompt(config) }],
    tools: createLocalTools(),
  }
}

// Keep history[0] (the system message) and the last `max` items.
export function trimHistory(history: ResponseInput, max: number): void {
  if (history.length - 1 <= max) return
  history.splice(1, history.length - 1 - max)
}

export async function handleLine(
  session: Session,
  line: string,
  sink: RunSink = process.stdout,
  signal?: AbortSignal,
): Promise<HandleResult> {
  const trimmed = line.trim()
  if (trimmed === '') return 'ok'
  const cmd = parseCommand(trimmed)
  if (cmd) return dispatch(session, cmd, sink)

  session.history.push({ role: 'user', content: trimmed })
  try {
    await runAgent(session.client, session.config, session.history, {
      sink,
      logger: session.logger,
      signal,
      tools: session.tools,
    })
    trimHistory(session.history, session.config.maxHistoryItems)
  } catch (err) {
    if (signal?.aborted) {
      session.logger.warn('aborted')
    } else {
      session.logger.error(errorMessage(err))
    }
  }
  return 'ok'
}

export async function startRepl(
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const session = createSession(config, logger)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  })
  let busy = false
  let ac: AbortController | undefined
  // Piped/non-TTY stdin can hit EOF (auto-closing `rl`) while a turn is still
  // in flight; rl.prompt() after that throws ERR_USE_AFTER_CLOSE. `rl.closed`
  // exists at runtime but isn't in @types/node, so catch instead of probing it.
  const showPrompt = () => {
    process.stdout.write(`${HINT}\n`)
    try {
      rl.prompt()
    } catch (err) {
      if (
        !(err instanceof Error) ||
        (err as NodeJS.ErrnoException).code !== 'ERR_USE_AFTER_CLOSE'
      )
        throw err
    }
  }
  rl.on('SIGINT', () => {
    if (busy) {
      ac?.abort()
      process.stdout.write('\n(aborted)\n')
    } else {
      showPrompt()
    }
  })
  showPrompt()
  try {
    for await (const line of rl) {
      busy = true
      ac = new AbortController()
      const result = await handleLine(session, line, process.stdout, ac.signal)
      busy = false
      if (result === 'exit') break
      showPrompt()
    }
  } finally {
    rl.close()
  }
}
