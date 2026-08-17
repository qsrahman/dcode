import ansis from 'ansis'
import type { AppConfig } from '../config/schema.ts'
import type { Client, ResponseInput } from '../agent/client.ts'
import type { RunSink } from '../agent/run.ts'
import type { Logger } from '../util/log.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { getVersion } from '../version.ts'

export interface Session {
  config: AppConfig
  logger: Logger
  client: Client
  history: ResponseInput
  tools: ToolRegistry
}

export type HandleResult = 'ok' | 'exit'

const HELP = ansis.dim(
  [
    'Commands:',
    '  /clear    clear the screen',
    '  /exit     quit',
    '  /help     show this help',
    '  /model    show/set model: /model <id>',
    '  /reset    clear the conversation',
    '  /tools    list available tools',
    '  /version  print version',
  ].join('\n'),
)

// ANSI sequence to clear screen + scrollback and move home.
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

export function parseCommand(
  line: string,
): { name: string; args: string } | null {
  if (!line.startsWith('/')) return null
  const rest = line.slice(1)
  const sp = rest.indexOf(' ')
  if (sp === -1) return { name: rest, args: '' }
  return { name: rest.slice(0, sp), args: rest.slice(sp + 1) }
}

export function dispatch(
  session: Session,
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
        sink.write(`model: ${session.config.model}\n`)
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
    case 'tools':
      for (const t of session.tools.list()) {
        sink.write(`${t.name} — ${t.description}\n`)
      }
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
