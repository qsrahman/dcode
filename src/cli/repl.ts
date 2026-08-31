import { createInterface } from 'node:readline/promises'
import { styleText } from 'node:util'
import OpenAI from 'openai'
import type { Config } from '../config/schema.ts'
import { createClient } from '../agent/client.ts'
import type { ResponseInput } from '../agent/client.ts'
import { TaskStore } from '../agent/tasks.ts'
import { ContextManager } from '../agent/context/manager.ts'
import { runAgent } from '../agent/loop.ts'
import { createLocalTools } from '../tools/index.ts'
import { resolveRoot } from '../config/config.ts'
import type { RunSink } from '../agent/run.ts'
import { type Logger, errorMessage } from '../util/log.ts'
import {
  type Session,
  type HandleResult,
  dispatch,
  parseCommand,
} from './commands.ts'
import { createCompleter } from './completer.ts'

const HINT = 'Ask anything, /help for commands...'
const PROMPT = styleText('cyan', '> ')

export function createSession(config: Config, logger: Logger): Session {
  const tasks = new TaskStore()
  return {
    config,
    logger,
    client: createClient(config),
    history: [],
    tools: createLocalTools(tasks),
    context: new ContextManager(config.context, logger, tasks),
    tasks,
    root: resolveRoot(config),
  }
}

// Keep roughly the last `max` items, plus item 0 unconditionally. The cut
// point is advanced forward past any tool items so the retained region
// always begins at a message boundary — otherwise trimming could keep a
// function_call_output whose function_call was dropped (or a function_call
// whose sibling output was dropped), which the Responses API rejects as an
// orphaned tool call. Erring toward keeping fewer items is fine; correctness
// beats hitting `max` exactly.
//
// Item 0 is protected because it's always either the session's very first
// user message, or — after an automatic or manual compaction —
// ContextManager's summary standing in for everything before it (compaction
// always produces `[summary, ...tail]`, and both start with `role: 'user'`,
// so there's nothing else in this array that could occupy index 0). Trimming
// from index 0 like every other cut point would silently discard that
// summary once the *item count* cap (independent of ContextManager's token
// budget) is hit on a long session — erasing the model's only record of the
// pre-compaction conversation, a far bigger loss than trimming any other
// single item.
export function trimHistory(history: ResponseInput, max: number): void {
  if (history.length <= max || history.length <= 1) return
  let keepFrom = Math.max(1, history.length - max)
  while (keepFrom < history.length && isToolItem(history[keepFrom]!)) keepFrom++
  if (keepFrom <= 1) return
  history.splice(1, keepFrom - 1)
}

function isToolItem(item: ResponseInput[number]): boolean {
  return item.type === 'function_call' || item.type === 'function_call_output'
}

// Why this doesn't also recognize `reasoning` items (which reasoning models
// require replayed immediately before their triggering function_call — see
// loop.ts): isToolItem's job is "never let the retained region *start* on
// an item with a required partner elsewhere," and a `reasoning` item's
// partner (its following function_call) is never at risk here. Landing
// exactly on a `reasoning` item stops the skip-forward there (it isn't a
// tool item), so the reasoning item and everything after it — including its
// function_call and function_call_output — are kept together. Landing on
// the function_call or function_call_output *is* recognized, and skips
// forward past the whole contiguous run, discarding that turn's
// reasoning+call+output together rather than ever leaving an orphaned half.
// So no case actually splits a reasoning item from its function_call; adding
// `reasoning` to isToolItem would only make the cut more aggressive (an
// optional reasoning item preceding a plain, non-tool-call message would
// get dropped too, since it'd no longer stop the skip there) for no
// correctness benefit.
//
// This — plus the item-0 protection above — is also why trimHistory stays a
// separate mechanism from ContextManager rather than being merged into it:
// they solve different problems (a hard item-count safety net vs. a
// token-budget-driven compaction policy), and the specific hazard a merge
// would exist to prevent (a cut splitting a required item pair) is already
// provably excluded by the two invariants above, not merely "usually fine."

export interface LineOpts {
  sink?: RunSink
  signal?: AbortSignal
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
  if (cmd) {
    // Guard command handlers: an error here (e.g. /save to a bad path, /compact
    // failing) must not escape and terminate the REPL loop.
    try {
      return await dispatch(session, cmd, sink)
    } catch (err) {
      session.logger.error(errorMessage(err))
      return 'ok'
    }
  }

  session.history.push({ role: 'user', content: trimmed })

  try {
    sink.write('\n')

    await runAgent(session.client, session.config, session.history, {
      sink,
      logger: session.logger,
      signal: opts.signal,
      tools: session.tools,
      context: session.context,
    })

    sink.write('\n')
    trimHistory(session.history, session.config.maxHistoryItems)
  } catch (err) {
    // Two distinct abort paths land here: the SDK throws APIUserAbortError
    // when the model request itself is cancelled mid-stream; runAgent throws
    // a plain Error('aborted') when the signal fires between tool calls
    // (after a turn already completed). Both are expected, not failures.
    if (!(err instanceof OpenAI.APIUserAbortError) && !opts.signal?.aborted) {
      session.logger.error(errorMessage(err))
    }
  }
  return 'ok'
}

export async function startRepl(config: Config, logger: Logger): Promise<void> {
  const session = createSession(config, logger)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: createCompleter(session.root),
  })
  rl.setPrompt(PROMPT)

  // `ac` is set only while a turn is in flight, so it doubles as the "busy"
  // flag: SIGINT aborts the current turn when present, otherwise just re-prompts.
  // The async-iterator loop already serializes turns (it awaits handleLine
  // before pulling the next line), so lines typed mid-turn are buffered by
  // readline and replayed in order — no manual pending queue needed.
  // `ac.signal` is passed straight into client.stream()'s request options
  // (see agent/client.ts), so aborting it cancels the in-flight model
  // request directly — no separate stream-handle-tracking needed.
  let ac: AbortController | undefined

  // A second idle SIGINT (no turn in flight) within this window exits,
  // matching the convention most REPLs use (bash, Python, Node's own
  // `repl` module) — a single idle Ctrl-C used to be a completely silent
  // no-op, which reads as "the terminal is frozen" rather than "nothing to
  // interrupt right now."
  const IDLE_EXIT_WINDOW_MS = 2000
  let idleSigintAt: number | undefined

  rl.on('SIGINT', () => {
    if (ac) {
      ac.abort()
      session.logger.warn('aborted')
      idleSigintAt = undefined
      return
    }
    const now = Date.now()
    if (
      idleSigintAt !== undefined &&
      now - idleSigintAt < IDLE_EXIT_WINDOW_MS
    ) {
      rl.close()
      return
    }
    idleSigintAt = now
    session.logger.warn('(To exit, press Ctrl-C again or type /exit)')
    rl.prompt()
  })

  process.stdout.write(`${HINT}\n`)
  rl.prompt()

  for await (const line of rl) {
    ac = new AbortController()

    const result = await handleLine(session, line, {
      sink: process.stdout,
      signal: ac.signal,
    })

    ac = undefined
    if (result === 'exit') {
      rl.close()
      return
    }
    rl.prompt()
  }
}
