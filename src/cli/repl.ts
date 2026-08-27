import { createInterface } from 'node:readline/promises'
import ansis from 'ansis'
import type { Config } from '../config/schema.ts'
import { createClient } from '../agent/client.ts'
import type { ResponseInput } from '../agent/client.ts'
import { TaskStore } from '../agent/tasks.ts'
import { ContextManager } from '../agent/context/manager.ts'
import { runAgent } from '../agent/loop.ts'
import { createLocalTools } from '../tools/index.ts'
import type { RunSink, StreamRef } from '../agent/run.ts'
import { type Logger, errorMessage } from '../util/log.ts'
import {
  type Session,
  type HandleResult,
  dispatch,
  parseCommand,
} from './commands.ts'

const HINT = 'Ask anything, /help for commands...'
const PROMPT = ansis.cyan('> ')

export function createSession(config: Config, logger: Logger): Session {
  const tasks = new TaskStore()
  return {
    config,
    logger,
    client: createClient(config),
    history: [],
    tools: createLocalTools(tasks),
    context: new ContextManager(config.context, logger),
    tasks,
  }
}

// Keep roughly the last `max` items. The cut point is advanced forward past any
// tool items so the retained region always begins at a message boundary —
// otherwise trimming could keep a function_call_output whose function_call was
// dropped (or a function_call whose sibling output was dropped), which the
// Responses API rejects as an orphaned tool call. Erring toward keeping fewer
// items is fine; correctness beats hitting `max` exactly.
export function trimHistory(history: ResponseInput, max: number): void {
  if (history.length <= max) return
  let keepFrom = history.length - max
  while (keepFrom < history.length && isToolItem(history[keepFrom]!)) keepFrom++
  history.splice(0, keepFrom)
}

function isToolItem(item: ResponseInput[number]): boolean {
  return item.type === 'function_call' || item.type === 'function_call_output'
}

export interface LineOpts {
  sink?: RunSink
  signal?: AbortSignal
  streamRef?: StreamRef
}

export async function handleLine(
  session: Session,
  line: string,
  opts: LineOpts = {},
): Promise<HandleResult> {
  const { sink = process.stdout } = opts
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
      signal: opts.signal,
      tools: session.tools,
      streamRef: opts.streamRef,
      context: session.context,
    })
    sink.write('\n')
    trimHistory(session.history, session.config.maxHistoryItems)
  } catch (err) {
    if (opts.signal?.aborted) {
      session.logger.warn('aborted')
    } else {
      session.logger.error(errorMessage(err))
    }
  }
  return 'ok'
}

export async function startRepl(
  config: Config,
  logger: Logger,
): Promise<void> {
  const session = createSession(config, logger)
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  rl.setPrompt(PROMPT)

  let busy = false
  let ac: AbortController | undefined
  const streamRef: StreamRef = { current: null }
  // Lines typed while a turn runs are buffered and drained after it finishes;
  // dropping them made users believe input they'd typed had been sent.
  const pending: string[] = []

  rl.on('SIGINT', () => {
    if (busy) {
      ac?.abort()
      streamRef.current?.abort()
      process.stdout.write('\n(aborted)\n')
    } else {
      rl.prompt()
    }
  })

  process.stdout.write(`${HINT}\n`)
  rl.prompt()

  for await (const line of rl) {
    if (busy) {
      pending.push(line)
      continue
    }

    busy = true
    try {
      let current: string | undefined = line
      while (current !== undefined) {
        ac = new AbortController()
        const result = await handleLine(session, current, {
          sink: process.stdout,
          signal: ac.signal,
          streamRef,
        })
        if (result === 'exit') {
          rl.close()
          return
        }
        current = pending.shift()
      }
    } finally {
      busy = false
    }
    rl.prompt()
  }
}
