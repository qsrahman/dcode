import * as readline from 'node:readline'
import ansis from 'ansis'
import type { AppConfig } from '../config/schema.ts'
import {
  createClient,
  type Client,
  type ResponseInput,
} from '../agent/client.ts'
import { buildSystemPrompt } from '../agent/system.ts'
import { runTurn, type RunSink } from '../agent/run.ts'
import { type Logger } from '../util/log.ts'
import { getVersion } from '../version.ts'

const HELP = `Slash commands:
  /help     show this help
  /model    set model: /model <id>
  /clear    clear the screen
  /reset    clear the conversation
  /version  print version
  /exit     quit`

// ANSI sequence to clear screen + scrollback and move home.
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'
const PROMPT = ansis.cyan('dcode> ')

export interface ReplSession {
  config: AppConfig
  logger: Logger
  client: Client
  history: ResponseInput
}

export function createSession(config: AppConfig, logger: Logger): ReplSession {
  return {
    config,
    logger,
    client: createClient(config, logger),
    history: [{ role: 'system', content: buildSystemPrompt(config) }],
  }
}

export function parseCommand(
  line: string,
): { name: string; args: string } | null {
  if (!line.startsWith('/')) return null
  const rest = line.slice(1)
  const sp = rest.indexOf(' ')
  if (sp === -1) return { name: rest, args: '' }
  return { name: rest.slice(0, sp), args: rest.slice(sp + 1) }
}

// Keep history[0] (the system message) and the last `max` items.
export function trimHistory(history: ResponseInput, max: number): void {
  if (history.length - 1 <= max) return
  history.splice(1, history.length - 1 - max)
}

export type HandleResult = 'ok' | 'exit'

function dispatch(
  session: ReplSession,
  cmd: { name: string; args: string },
  sink: RunSink,
): HandleResult {
  switch (cmd.name) {
    case 'help':
      sink.write(HELP + '\n')
      return 'ok'
    case 'version':
      sink.write(`dcode v${getVersion()}\n`)
      return 'ok'
    case 'model': {
      const id = cmd.args.trim()
      if (!id) {
        sink.write('usage: /model <id>\n')
        return 'ok'
      }
      session.config.model = id
      sink.write(`model set to ${id}\n`)
      return 'ok'
    }
    case 'reset':
      session.history = [session.history[0]!]
      sink.write('session reset\n')
      return 'ok'
    case 'clear':
      sink.write(CLEAR)
      return 'ok'
    case 'exit':
      return 'exit'
    default:
      sink.write(`unknown command: /${cmd.name} (try /help)\n`)
      return 'ok'
  }
}

export async function handleLine(
  session: ReplSession,
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
    const text = await runTurn(
      session.client,
      session.config,
      session.history,
      sink,
      session.logger,
      signal,
    )
    session.history.push({ role: 'assistant', content: text })
    trimHistory(session.history, session.config.maxHistoryItems)
  } catch (err) {
    if (signal?.aborted) {
      session.logger.warn('aborted')
    } else {
      session.logger.error(err instanceof Error ? err.message : String(err))
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
  let ac = new AbortController()
  rl.on('SIGINT', () => {
    if (busy) {
      ac.abort()
      process.stdout.write('\n(aborted)\n')
    } else {
      rl.prompt()
    }
  })
  rl.prompt()
  try {
    for await (const line of rl) {
      busy = true
      ac = new AbortController()
      const result = await handleLine(session, line, process.stdout, ac.signal)
      busy = false
      if (result === 'exit') break
      rl.prompt()
    }
  } finally {
    rl.close()
  }
}
