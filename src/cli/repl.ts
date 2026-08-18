import * as readline from 'node:readline'
import ansis from 'ansis'
import type { AppConfig } from '../config/schema.ts'
import { createClient } from '../agent/client.ts'
import type { ResponseInput } from '../agent/client.ts'
import { buildSystemPrompt } from '../agent/system.ts'
import { runAgent } from '../agent/loop.ts'
import { createLocalTools } from '../tools/index.ts'
import { createAllowGate, createConfirmGate, type Gate } from '../agent/gate.ts'
import type { RunSink } from '../agent/run.ts'
import { type Logger, errorMessage } from '../util/log.ts'
import {
  type Session,
  type HandleResult,
  dispatch,
  parseCommand,
} from './commands.ts'

const HINT = 'Ask anything, /help for commands...'
const PROMPT = ansis.cyan('> ')

export function createSession(
  config: AppConfig,
  logger: Logger,
  gate: Gate = createAllowGate(),
): Session {
  return {
    config,
    logger,
    client: createClient(config, logger),
    history: [{ role: 'system', content: buildSystemPrompt(config) }],
    tools: createLocalTools(),
    gate,
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
    sink.write('\n')
    await runAgent(session.client, session.config, session.history, {
      sink,
      logger: session.logger,
      signal,
      tools: session.tools,
      gate: session.gate,
    })
    sink.write('\n')
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
  // A gate confirmation question is answered on the next input line; while it is
  // pending we must not treat that line as a new user command (and must not
  // re-show the REPL prompt, which belongs to the turn still in flight).
  let pendingGate: ((answer: string) => void) | null = null
  const gateAsk = (promptText: string): Promise<string> =>
    new Promise<string>((resolve) => {
      process.stdout.write(promptText)
      pendingGate = resolve
    })

  const session = createSession(config, logger, createConfirmGate(gateAsk))
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
      if (pendingGate) {
        const resolve = pendingGate
        pendingGate = null
        resolve('n')
      }
      process.stdout.write('\n(aborted)\n')
    } else {
      showPrompt()
    }
  })
  rl.on('line', async (line: string) => {
    if (pendingGate) {
      const resolve = pendingGate
      pendingGate = null
      resolve(line)
      return
    }
    if (busy) return
    busy = true
    ac = new AbortController()
    const result = await handleLine(session, line, process.stdout, ac.signal)
    busy = false
    if (result === 'exit') {
      rl.close()
      return
    }
    showPrompt()
  })
  return new Promise<void>((resolve) => {
    rl.on('close', () => resolve())
    showPrompt()
  })
}
