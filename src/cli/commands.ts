import type { Config } from '../config/schema.ts'
import { paintFor } from '../util/color.ts'
import type { Client, ResponseInput } from '../agent/client.ts'
import type { RunSink } from '../agent/run.ts'
import type { Logger } from '../util/log.ts'
import type { ResponseItemFields } from '../agent/types.ts'
import { contentToText } from '../agent/context/tokens.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { CommandRegistry } from './registry.ts'
import type { ContextManager } from '../agent/context/manager.ts'
import type { TaskStore } from '../agent/todo-store.ts'
import type { McpManager } from '../tools/mcp/manager.ts'
import { globalConfigPath } from '../config/config.ts'
import { getVersion } from '../util/version.ts'
import { access, mkdir, writeFile } from 'node:fs/promises'
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
  mcp: McpManager
}

// 'edit' asks the REPL loop to open the user's editor and submit the result as
// a prompt. It's a loop-level action rather than something the handler does
// itself because the editor needs the terminal (the loop owns the readline
// interface to pause/resume) and the follow-up turn needs the loop's abort
// signal — neither of which a command handler has access to.
export type HandleResult = 'ok' | 'exit' | 'edit'

// ANSI sequence to clear screen + scrollback and move home.
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

// `/help` text and `SLASH_COMMANDS` are derived from the command registry below.

// Best-effort Markdown rendering of a conversation transcript for `/save`.
function historyToMarkdown(history: ResponseInput): string {
  const parts: string[] = []
  for (const item of history) {
    const it = item as ResponseItemFields
    if (it.type === 'function_call') {
      parts.push(
        `## tool call: ${it.name}\n\n\`\`\`json\n${it.arguments}\n\`\`\`\n`,
      )
    } else if (it.type === 'function_call_output') {
      parts.push(`## tool output\n\n\`\`\`\n${it.output}\n\`\`\`\n`)
    } else if ('role' in it && 'content' in it) {
      // contentToText, not a local `typeof === 'string' ? ... : JSON.stringify`
      // reimplementation: message content is often an array of parts, which
      // the local version dumped into the transcript as raw JSON.
      parts.push(`## ${it.role}\n\n${contentToText(it.content)}\n`)
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
    sink.write(`[${t.status}] [${t.priority}] ${t.content}\n`)
  }
  return 'ok'
}

// `/help` text derived from the registry so the listing can never drift from the
// actual commands (no separate description map to keep in sync). Closes over
// the module-level COMMANDS singleton rather than taking a registry
// parameter — its one caller below always passes that same singleton.
// `color` comes from the session's config, not styleText's own auto-detection
// (see util/color.ts's paintFor) — otherwise --no-color couldn't suppress it.
function buildHelp(color: boolean): string {
  const defs = COMMANDS.list().sort((a, b) => a.name.localeCompare(b.name))
  // Derived from the actual longest name rather than a fixed width, so a
  // future command with a name longer than the old hardcoded 8 can't
  // silently misalign every other line's description column.
  const width = Math.max(...defs.map((c) => c.name.length))
  const lines = defs.map((c) => {
    const aliasNote = c.aliases?.length
      ? ` (alias: ${c.aliases.map((a) => `/${a}`).join(', ')})`
      : ''
    return `  /${c.name.padEnd(width)} ${c.description}${aliasNote}`
  })
  return paintFor(color).dim(['Commands:', ...lines].join('\n'))
}

export function createCommands(): CommandRegistry {
  const r = new CommandRegistry()
  r.register({
    name: 'help',
    description: 'show this help',
    handler: (session, _a, sink) => {
      sink.write(buildHelp(session.config.color) + '\n')
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
    description: 'clear the conversation (requires: /reset confirm)',
    handler: (session, args, sink) => {
      // The system prompt lives in `instructions`, not in `history`, so a reset
      // just drops the conversation entirely. There's no undo for this (unlike
      // /undo itself, which only drops the last exchange) — require an explicit
      // confirm arg, the same non-interactive "refuse and explain" pattern
      // /save uses for its own overwrite guard, rather than a fully silent,
      // one-shot destructive command.
      if (args.trim() !== 'confirm') {
        const n = session.history.length
        sink.write(
          `this clears the entire conversation (${n} item${n === 1 ? '' : 's'}) and cannot be undone — run /save first to keep it, then /reset confirm\n`,
        )
        return 'ok'
      }
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
    name: 'mcp',
    description: 'show configured MCP servers, their status, and tool counts',
    handler: (session, _a, sink) => {
      if (session.mcp.servers.length === 0) {
        sink.write('no MCP servers configured\n')
        return 'ok'
      }
      const lines = session.mcp.servers.map((s) => {
        if (s.status === 'connected') {
          return `  ${s.name.padEnd(20)} connected (${s.toolCount} tool${s.toolCount === 1 ? '' : 's'})`
        }
        if (s.status === 'disabled') {
          return `  ${s.name.padEnd(20)} disabled (set enabled: true to connect)`
        }
        return `  ${s.name.padEnd(20)} failed — ${s.error ?? 'unknown error'}`
      })
      sink.write(['MCP servers:', ...lines].join('\n') + '\n')
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
      // Unlike streamed model turns, this is a single model call with no
      // incremental output — without something printed first, a slow
      // endpoint or a large history leaves the terminal looking frozen
      // until the whole summary comes back.
      sink.write('compacting…\n')
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
        `keys:         ${keysLine} (values hidden)`,
        `maxTools:     ${c.maxToolIterations}`,
        `maxToolOut:   ${c.maxToolOutputBytes} bytes`,
        `toolTimeout:  ${c.toolTimeout} ms`,
        `maxRetries:   ${c.maxRetries}`,
        `context:      window=${c.context.window} reserved=${c.context.reserved} keep=${c.context.keepTokens} prune=${c.context.prune} auto=${c.context.auto}`,
        `mcpServers:   ${Object.keys(c.mcpServers).length} configured, ${Object.values(c.mcpServers).filter((s) => s.enabled).length} enabled (see /mcp)`,
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
        (it) => (it as ResponseItemFields).role === 'user',
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
      if (sub === 'set' || sub === 'unset') {
        const provider = parts[1]?.toLowerCase()
        const value = parts.slice(2).join(' ')
        if (!provider || (sub === 'set' && !value)) {
          sink.write(
            `usage: /key ${sub} <${KEY_PROVIDERS.join('|')}>${sub === 'set' ? ' <value>' : ''}\n`,
          )
          return 'ok'
        }
        if (!isKnownProvider(provider)) {
          sink.write(
            `unknown provider: ${provider} (known: ${KEY_PROVIDERS.join(', ')})\n`,
          )
          return 'ok'
        }
        const field = keyField(provider)
        if (sub === 'set') {
          setGlobalKey(field, value)
          session.config[field] = value
        } else {
          unsetGlobalKey(field)
          delete (session.config as Record<string, unknown>)[field]
        }
        // The OpenAI client captured the key at construction; rebuild it so
        // the change is actually used for subsequent requests this session.
        session.client = createClient(session.config)
        sink.write(
          sub === 'set'
            ? `stored ${provider} key in ${globalConfigPath()}\n`
            : `cleared ${provider} key\n`,
        )
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
    handler: async (session, args, sink): Promise<HandleResult> => {
      const arg = args.trim()
      const useMarkdown = arg.endsWith('.md')
      const fileName = arg || `dcode-transcript.${useMarkdown ? 'md' : 'json'}`
      const target = join(session.root, fileName)
      let exists = false
      try {
        await access(target)
        exists = true
      } catch {
        // file doesn't exist — safe to write
      }
      if (exists) {
        sink.write(
          `refusing to overwrite ${target} (choose a different path)\n`,
        )
        return 'ok'
      }
      const payload = useMarkdown
        ? historyToMarkdown(session.history)
        : JSON.stringify(session.history, null, 2)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, payload)
      sink.write(`saved ${session.history.length} items to ${target}\n`)
      return 'ok'
    },
  })
  r.register({
    name: 'edit',
    description: 'compose a prompt in $VISUAL/$EDITOR, then send it',
    // The loop performs the editor round-trip (see HandleResult 'edit'); the
    // handler only signals the intent. Args are ignored — the prompt is
    // whatever the editor buffer contains on close.
    handler: () => 'edit',
  })
  r.register({
    name: 'exit',
    description: 'quit dcode',
    handler: () => 'exit',
  })
  return r
}

// `createCommands()` is exported so tests can build their own isolated
// registry (no shared mutable Map across test files) and inspect it
// directly via .get()/.list()/.names(). Production only ever uses this one
// instance, though: `dispatch`/`buildHelp`/`SLASH_COMMANDS` below all
// resolve against the module-level COMMANDS singleton, not whatever
// registry a caller happens to hold — there's currently no notion of a
// per-session command set, so there's nothing to inject. If that ever
// changes (e.g. per-session custom commands), `dispatch` would need a
// registry parameter instead of closing over COMMANDS.
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
