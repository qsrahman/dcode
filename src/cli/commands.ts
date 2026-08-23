import ansis from 'ansis'
import type { AppConfig } from '../config/schema.ts'
import type { Client, ResponseInput } from '../agent/client.ts'
import type { RunSink } from '../agent/run.ts'
import type { Logger } from '../util/log.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ContextManager } from '../agent/context/manager.ts'
import { getVersion } from '../version.ts'

export interface Session {
  config: AppConfig
  logger: Logger
  client: Client
  history: ResponseInput
  tools: ToolRegistry
  context: ContextManager
}

export type HandleResult = 'ok' | 'exit'

// ANSI sequence to clear screen + scrollback and move home.
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

const HELP = ansis.dim(
  [
    'Commands:',
    '  /clear    clear the screen',
    '  /compact  summarize the oldest conversation into a short summary',
    '  /context  show estimated token usage vs. the model window',
    '  /exit     quit dcode',
    '  /help     show this help',
    '  /model    show/set model: /model <id>',
    '  /reset    clear the conversation',
    '  /tools    list available tools',
    '  /version  print version',
  ].join('\n'),
)

type CommandHandler = (
  session: Session,
  args: string,
  sink: RunSink,
) => Promise<HandleResult> | HandleResult

const commands: Record<string, CommandHandler> = {
  help: (_session, _args, sink) => {
    sink.write(HELP + '\n')
    return 'ok'
  },
  version: (_session, _args, sink) => {
    sink.write(`dcode v${getVersion()}\n`)
    return 'ok'
  },
  model: (session, args, sink) => {
    const id = args.trim()
    if (!id) {
      sink.write(`model: ${session.config.model}\n`)
      return 'ok'
    }
    session.config.model = id
    sink.write(`model set to ${id}\n`)
    return 'ok'
  },
  reset: (session, _args, sink) => {
    session.history = [session.history[0]!]
    sink.write('session reset\n')
    return 'ok'
  },
  tools: (session, _args, sink) => {
    sink.write(
      `Tools: ${session.tools
        .list()
        .map((t) => t.name)
        .join(', ')}\n`,
    )
    return 'ok'
  },
  clear: (_session, _args, sink) => {
    sink.write(CLEAR)
    return 'ok'
  },
  compact: async (session, _args, sink): Promise<HandleResult> => {
    await session.context.manual(
      session.client,
      session.config,
      session.history,
    )
    sink.write('conversation compacted\n')
    return 'ok'
  },
  context: (session, _args, sink) => {
    const r = session.context.report(session.history)
    sink.write(
      `context: ~${r.used} / ${r.usable} tokens used (model window ${session.config.context.window})\n`,
    )
    return 'ok'
  },
  exit: () => 'exit',
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

export async function dispatch(
  session: Session,
  cmd: { name: string; args: string },
  sink: RunSink,
): Promise<HandleResult> {
  const handler = commands[cmd.name]
  if (!handler) {
    sink.write(`unknown command: /${cmd.name} (try /help)\n`)
    return 'ok'
  }
  return handler(session, cmd.args, sink)
}
