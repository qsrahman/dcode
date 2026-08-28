import ansis from 'ansis'
import type { Config } from '../config/schema.ts'
import type { Client, ResponseInput } from '../agent/client.ts'
import type { RunSink } from '../agent/run.ts'
import type { Logger } from '../util/log.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { CommandRegistry } from './registry.ts'
import type { ContextManager } from '../agent/context/manager.ts'
import type { TaskStore } from '../agent/tasks.ts'
import { globalConfigPath } from '../config/config.ts'
import { getVersion } from '../version.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createClient } from '../agent/client.ts'
import {
  isKnownProvider,
  keyField,
  KEY_PROVIDERS,
  setGlobalKey,
  unsetGlobalKey,
} from './keys.ts'

export interface Session {
  config: Config
  logger: Logger
  client: Client
  history: ResponseInput
  tools: ToolRegistry
  context: ContextManager
  tasks: TaskStore
  root: string
}

export type HandleResult = 'ok' | 'exit'

// ANSI sequence to clear screen + scrollback and move home.
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

// `/help` text and `SLASH_COMMANDS` are derived from the command registry below.

// Best-effort Markdown rendering of a conversation transcript for `/save`.
function historyToMarkdown(history: ResponseInput): string {
  const parts: string[] = []
  for (const item of history) {
    const it = item as {
      type: string
      role?: string
      content?: unknown
      name?: string
      arguments?: string
      output?: string
    }
    if (it.type === 'function_call') {
      parts.push(
        `## tool call: ${it.name}\n\n\`\`\`json\n${it.arguments}\n\`\`\`\n`,
      )
    } else if (it.type === 'function_call_output') {
      parts.push(`## tool output\n\n\`\`\`\n${it.output}\n\`\`\`\n`)
    } else if ('role' in it && 'content' in it) {
      const text =
        typeof it.content === 'string' ? it.content : JSON.stringify(it.content)
      parts.push(`## ${it.role}\n\n${text}\n`)
    }
  }
  return parts.join('\n')
}

function listTasks(
  session: Session,
  _args: string,
  sink: RunSink,
): HandleResult {
  const list = session.tasks.list()
  if (list.length === 0) {
    sink.write('no tasks\n')
    return 'ok'
  }
  for (const t of list) {
    const blocked = t.blockedBy.length
      ? ` (blocked by ${t.blockedBy.join(', ')})`
      : ''
    sink.write(`${t.id} [${t.status}] ${t.title}${blocked}\n`)
  }
  return 'ok'
}

// `/help` text derived from the registry so the listing can never drift from the
// actual commands (no separate description map to keep in sync).
function buildHelp(registry: CommandRegistry): string {
  const lines = registry
    .list()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const aliasNote = c.aliases?.length
        ? ` (alias: ${c.aliases.map((a) => `/${a}`).join(', ')})`
        : ''
      return `  /${c.name.padEnd(8)} ${c.description}${aliasNote}`
    })
  return ansis.dim(['Commands:', ...lines].join('\n'))
}

export function createCommands(): CommandRegistry {
  const r = new CommandRegistry()
  r.register({
    name: 'help',
    description: 'show this help',
    handler: (_s, _a, sink) => {
      sink.write(buildHelp(COMMANDS) + '\n')
      return 'ok'
    },
  })
  r.register({
    name: 'version',
    description: 'print version',
    handler: (_s, _a, sink) => {
      sink.write(`dcode v${getVersion()}\n`)
      return 'ok'
    },
  })
  r.register({
    name: 'model',
    description: 'show/set model: /model <id>',
    handler: (session, args, sink) => {
      const id = args.trim()
      if (!id) {
        sink.write(`model: ${session.config.model}\n`)
        return 'ok'
      }
      session.config.model = id
      // Rebuild the client so the new model takes effect even if createClient
      // ever captures config by value instead of by the shared object reference.
      session.client = createClient(session.config)
      sink.write(`model set to ${id}\n`)
      return 'ok'
    },
  })
  r.register({
    name: 'reset',
    description: 'clear the conversation',
    handler: (session, _a, sink) => {
      // The system prompt lives in `instructions`, not in `history`, so a reset
      // just drops the conversation entirely.
      session.history = []
      sink.write('session reset\n')
      return 'ok'
    },
  })
  r.register({
    name: 'tools',
    description: 'list available tools',
    handler: (session, _a, sink) => {
      sink.write(
        `Tools: ${session.tools
          .list()
          .map((t) => t.name)
          .join(', ')}\n`,
      )
      return 'ok'
    },
  })
  r.register({
    name: 'clear',
    description: 'clear the screen',
    handler: (_s, _a, sink) => {
      sink.write(CLEAR)
      return 'ok'
    },
  })
  r.register({
    name: 'compact',
    description: 'summarize the oldest conversation into a short summary',
    handler: async (session, _a, sink): Promise<HandleResult> => {
      await session.context.manual(
        session.client,
        session.config,
        session.history,
      )
      sink.write('conversation compacted\n')
      return 'ok'
    },
  })
  r.register({
    name: 'context',
    description: 'show estimated token usage vs. the model window',
    handler: (session, _a, sink) => {
      const rep = session.context.report(session.history)
      sink.write(
        `context: ~${rep.used} / ${rep.usable} tokens used (model window ${session.config.context.window})\n`,
      )
      return 'ok'
    },
  })
  r.register({
    name: 'tasks',
    description: 'list in-session tasks',
    aliases: ['todo'],
    handler: listTasks,
  })
  r.register({
    name: 'config',
    description: 'print effective configuration',
    handler: (session, _a, sink) => {
      const c = session.config
      const keysLine = KEY_PROVIDERS.map(
        (p) => `${p}=${c[keyField(p)] ? 'set' : 'unset'}`,
      ).join(' ')
      const lines = [
        `model:        ${c.model}`,
        `baseURL:      ${c.baseURL ?? '(default)'}`,
        `stateful:     ${c.stateful}`,
        `verbose:      ${c.verbose}`,
        `keys:         ${keysLine} (values hidden)`,
        `maxTools:     ${c.maxToolIterations}`,
        `maxHistory:   ${c.maxHistoryItems}`,
        `maxToolOut:   ${c.maxToolOutputBytes} bytes`,
        `toolTimeout:  ${c.toolTimeout} ms`,
        `maxRetries:   ${c.maxRetries}`,
        `context:      window=${c.context.window} reserved=${c.context.reserved} keep=${c.context.keepTokens} prune=${c.context.prune} auto=${c.context.auto}`,
      ]
      sink.write(lines.join('\n') + '\n')
      return 'ok'
    },
  })
  r.register({
    name: 'undo',
    description: 'remove the last exchange (user turn + response)',
    handler: (session, _a, sink) => {
      const h = session.history
      const lastUser = h.findLastIndex(
        (it) => (it as { role?: string }).role === 'user',
      )
      if (lastUser === -1) {
        sink.write('nothing to undo\n')
        return 'ok'
      }
      h.splice(lastUser)
      sink.write('undid last exchange\n')
      return 'ok'
    },
  })
  r.register({
    name: 'verbose',
    description: 'toggle verbose mode (on|off)',
    handler: (session, args, sink) => {
      const arg = args.trim()
      if (arg === 'on') session.config.verbose = true
      else if (arg === 'off') session.config.verbose = false
      else session.config.verbose = !session.config.verbose
      sink.write(`verbose: ${session.config.verbose ? 'on' : 'off'}\n`)
      return 'ok'
    },
  })
  r.register({
    name: 'key',
    description: 'store/show API keys (openai, brave)',
    handler: (session, args, sink) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0]
      if (sub === 'list' || sub === undefined) {
        const status = KEY_PROVIDERS.map(
          (p) =>
            `  ${p.padEnd(7)} ${session.config[keyField(p)] ? 'set' : 'not set'}`,
        ).join('\n')
        sink.write(`keys (global config, values hidden):\n${status}\n`)
        return 'ok'
      }
      if (sub === 'set') {
        const provider = parts[1]?.toLowerCase()
        const value = parts.slice(2).join(' ')
        if (!provider || !value) {
          sink.write('usage: /key set <openai|brave> <value>\n')
          return 'ok'
        }
        if (!isKnownProvider(provider)) {
          sink.write(
            `unknown provider: ${provider} (known: ${KEY_PROVIDERS.join(', ')})\n`,
          )
          return 'ok'
        }
        const field = keyField(provider)
        setGlobalKey(field, value)
        session.config[field] = value
        // The OpenAI client captured the key at construction; rebuild it so the
        // new key is actually used for subsequent requests this session.
        session.client = createClient(session.config)
        sink.write(`stored ${provider} key in ${globalConfigPath()}\n`)
        return 'ok'
      }
      if (sub === 'unset') {
        const provider = parts[1]?.toLowerCase()
        if (!provider) {
          sink.write('usage: /key unset <openai|brave>\n')
          return 'ok'
        }
        if (!isKnownProvider(provider)) {
          sink.write(`unknown provider: ${provider}\n`)
          return 'ok'
        }
        const field = keyField(provider)
        unsetGlobalKey(field)
        delete (session.config as Record<string, unknown>)[field]
        session.client = createClient(session.config)
        sink.write(`cleared ${provider} key\n`)
        return 'ok'
      }
      sink.write('usage: /key <set|unset|list> [provider] [value]\n')
      return 'ok'
    },
  })
  r.register({
    name: 'limit',
    description: 'set maxToolIterations at runtime: /limit <n>',
    handler: (session, args, sink) => {
      const n = Number.parseInt(args.trim(), 10)
      if (!Number.isInteger(n) || n < 1) {
        sink.write('usage: /limit <positive integer>\n')
        return 'ok'
      }
      session.config.maxToolIterations = n
      sink.write(`maxToolIterations set to ${n}\n`)
      return 'ok'
    },
  })
  r.register({
    name: 'save',
    description:
      'write the conversation transcript to a file (/save [path.md|path.json])',
    handler: (session, args, sink) => {
      const arg = args.trim()
      const useMarkdown = arg.endsWith('.md')
      const fileName = arg || `dcode-transcript.${useMarkdown ? 'md' : 'json'}`
      const target = join(session.root, fileName)
      if (existsSync(target)) {
        sink.write(
          `refusing to overwrite ${target} (choose a different path)\n`,
        )
        return 'ok'
      }
      const payload = useMarkdown
        ? historyToMarkdown(session.history)
        : JSON.stringify(session.history, null, 2)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, payload)
      sink.write(`saved ${session.history.length} items to ${target}\n`)
      return 'ok'
    },
  })
  r.register({
    name: 'exit',
    description: 'quit dcode',
    handler: () => 'exit',
  })
  return r
}

const COMMANDS = createCommands()
export const SLASH_COMMANDS = COMMANDS.names()

export function parseCommand(
  line: string,
): { name: string; args: string } | null {
  if (!line.startsWith('/')) return null
  const rest = line.slice(1)
  const sp = rest.indexOf(' ')
  // Only the command name is normalized; args (keys, paths, model ids) keep case.
  if (sp === -1) return { name: rest.toLowerCase(), args: '' }
  return { name: rest.slice(0, sp).toLowerCase(), args: rest.slice(sp + 1) }
}

export async function dispatch(
  session: Session,
  cmd: { name: string; args: string },
  sink: RunSink,
): Promise<HandleResult> {
  const def = COMMANDS.get(cmd.name)
  if (!def) {
    sink.write(`unknown command: /${cmd.name} (try /help)\n`)
    return 'ok'
  }
  return def.handler(session, cmd.args, sink)
}
