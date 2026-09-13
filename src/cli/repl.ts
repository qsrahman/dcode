import { createInterface } from 'node:readline/promises'
import type { Config } from '../config/schema.ts'
import { createClient } from '../agent/client.ts'
import { TaskStore } from '../agent/todo-store.ts'
import { ContextManager } from '../agent/context/manager.ts'
import { runAgent } from '../agent/loop.ts'
import { createLocalTools } from '../tools/index.ts'
import { connectMcpServers } from '../tools/mcp/manager.ts'
import type { RunSink } from '../agent/run.ts'
import { type Logger, errorMessage, isAbortError } from '../util/log.ts'
import {
  type Session,
  type HandleResult,
  dispatch,
  parseCommand,
} from './commands.ts'
import { createCompleter } from './completer.ts'
import { openInEditor, resolveEditor, NO_EDITOR_MESSAGE } from './editor.ts'
import { paintFor } from '../util/color.ts'

const HINT = 'Ask anything, /help for commands...'

// Async because connecting configured MCP servers (decision I: spawn/connect
// at startup) is: stdio servers are spawned, HTTP servers are dialed, and
// each is given up to CONNECT_TIMEOUT_MS before being skipped with a warning
// (see tools/mcp/manager.ts). With no servers configured (the default) this
// resolves immediately — no added startup latency for the common case.
export async function createSession(
  config: Config,
  logger: Logger,
): Promise<Session> {
  const tasks = new TaskStore()
  const client = createClient(config)
  const mcp = await connectMcpServers(config.mcpServers, logger)
  return {
    config,
    logger,
    client,
    history: [],
    tools: createLocalTools(tasks, client, mcp.tools),
    context: new ContextManager(config.context, logger, tasks),
    tasks,
    root: process.cwd(),
    mcp,
  }
}

export interface LineOpts {
  sink?: RunSink
  signal?: AbortSignal
  // Treat the line as a prompt even if it begins with '/'. Set when submitting
  // text composed in the editor (/edit), which is prose to send, never a
  // command to re-parse — a prompt that happens to open with a slash must not
  // be swallowed as an unknown command.
  asPrompt?: boolean
}

export async function handleLine(
  session: Session,
  line: string,
  opts: LineOpts = {},
): Promise<HandleResult> {
  const { sink = process.stdout } = opts
  const trimmed = line.trim()

  if (trimmed === '') return 'ok'

  const cmd = opts.asPrompt ? null : parseCommand(trimmed)
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
  } catch (err) {
    if (!isAbortError(err, opts.signal)) {
      session.logger.error(errorMessage(err))
    }
  }
  return 'ok'
}

// Run the /edit round-trip: open the user's editor on a scratch buffer and
// return what they wrote, or null (no editor configured, an editor error, or an
// empty buffer). Readline is paused for the duration so the editor owns the
// terminal, and raw mode is reasserted afterward because a full-screen editor
// leaves the tty in cooked mode on exit — without this the resumed prompt would
// double-echo and mishandle arrow keys.
async function composeInEditor(
  rl: { pause(): void; resume(): void },
  logger: Logger,
): Promise<string | null> {
  if (!resolveEditor()) {
    logger.warn(NO_EDITOR_MESSAGE)
    return null
  }
  rl.pause()
  try {
    const text = await openInEditor()
    return text && text.trim() ? text : null
  } catch (err) {
    logger.error(errorMessage(err))
    return null
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    rl.resume()
  }
}

export async function startRepl(config: Config, logger: Logger): Promise<void> {
  const session = await createSession(config, logger)
  try {
    await runRepl(session)
  } finally {
    // Decision I: session-lived, closed on exit — covers both the 'exit'
    // command and the idle-double-Ctrl-C path, since both end runRepl's
    // loop (by returning, or by rl.close() ending the async iterator) rather
    // than the process itself, so this always runs before startRepl returns.
    await session.mcp.close()
  }
}

async function runRepl(session: Session): Promise<void> {
  // Session-scoped, not a module-level constant: it has to read config.color
  // (see util/color.ts's paintFor) rather than styleText's own auto-detection,
  // or --no-color could never suppress it.
  const PROMPT = paintFor(session.config.color).cyan('> ')

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
    if (result === 'edit') {
      const text = await composeInEditor(rl, session.logger)
      if (text) {
        // Echo the composed prompt so the terminal (and any later /save) has a
        // record of what was sent — it was typed in an external buffer, so
        // nothing of it reached the screen otherwise.
        process.stdout.write(`${PROMPT}${text.trim()}\n`)
        ac = new AbortController()
        await handleLine(session, text, {
          sink: process.stdout,
          signal: ac.signal,
          asPrompt: true,
        })
        ac = undefined
      }
    }
    rl.prompt()
  }
}
