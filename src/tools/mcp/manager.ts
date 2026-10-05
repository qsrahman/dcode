import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import type { McpServerConfig } from '../../config/schema.ts'
import type { ToolContext, ToolDefinition } from '../../agent/types.ts'
import { defineTool } from '../registry.ts'
import type { Logger } from '../../util/log.ts'
import { errorMessage } from '../../util/log.ts'
import { getVersion } from '../../util/version.ts'
import { safeEnv } from '../local/exec.ts'

// Connects to every configured MCP server (decision I, PLAN.md §6: spawn/
// connect at startup, session-lived, close on exit/SIGINT) and exposes each
// server's tools as ordinary ToolDefinitions that slot into the same
// ToolRegistry as dcode's built-in tools — the agent loop, sub_agent tool, and
// sub-agent filtering all treat them identically; nothing downstream needs to
// know a tool came from MCP rather than tools/local/.

const CONNECT_TIMEOUT_MS = 10_000

export interface McpServerStatus {
  name: string
  status: 'connected' | 'failed' | 'disabled'
  toolCount: number
  error?: string
}

export interface McpManager {
  tools: ToolDefinition[]
  servers: McpServerStatus[]
  // Best-effort: closes every connected client (kills stdio child processes,
  // drops HTTP connections). Never throws — a server that's already gone or
  // wedged must not block shutdown.
  close(): Promise<void>
}

// Args are passed straight through to the MCP server, which is authoritative
// on their shape (see ToolDefinition.jsonSchema) — dcode only needs to know
// it's a JSON object, so parsing here is a permissive passthrough rather than
// real validation.
const mcpArgsSchema = z.record(z.string(), z.unknown())

// A value that is *exactly* `${VAR_NAME}` is replaced with process.env.
// VAR_NAME, read fresh at connect time — never persisted, never logged. This
// is what lets a header or stdio env value reference a secret kept in the
// shell instead of sitting in dcode.json in the clear, the same
// keep-secrets-out-of-the-config-file principle `/key` already serves for
// the OpenAI/Brave keys. Deliberately whole-value-only (no partial
// interpolation inside a larger string): that keeps the syntax trivial to
// parse and to reason about, at the cost of not supporting e.g. `Bearer
// ${TOKEN}` in one string — a header value that needs a "Bearer " prefix has
// to fold it into the env var itself. Unset throws rather than silently
// sending a literal `${VAR}` or an empty string to the server/child process,
// which would either look like a broken placeholder or, worse, a
// silently-unauthenticated request.
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

function expandEnvPlaceholder(value: string, context: string): string {
  const m = ENV_PLACEHOLDER.exec(value)
  if (!m) return value
  const varName = m[1]!
  const resolved = process.env[varName]
  if (resolved === undefined) {
    throw new Error(
      `${context} references \${${varName}}, but that environment variable is not set`,
    )
  }
  return resolved
}

function expandEnvPlaceholders(
  values: Record<string, string>,
  contextPrefix: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      expandEnvPlaceholder(v, `${contextPrefix}.${k}`),
    ]),
  )
}

function makeTransport(server: string, cfg: McpServerConfig): Transport {
  if (cfg.type === 'remote') {
    const headers = cfg.headers
      ? expandEnvPlaceholders(cfg.headers, `mcpServers.${server}.headers`)
      : undefined
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: headers ? { headers } : undefined,
    })
  }
  const explicitEnv = cfg.env
    ? expandEnvPlaceholders(cfg.env, `mcpServers.${server}.env`)
    : {}
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    // The server's own configured env layers on top of the filtered ambient
    // env (see exec.ts's safeEnv) rather than replacing it: a server commonly
    // needs its own secret (an API key) passed explicitly, which is exactly
    // what `env` in the config is for, while PATH/HOME/etc. still come
    // through and ambient secret-looking vars stay stripped.
    env: { ...safeEnv(), ...explicitEnv },
    stderr: 'pipe',
  })
}

// A qualified tool name has to be unique across every connected server and
// stay within the Responses API's function-name character set. Two different
// servers can legally expose a same-named tool (e.g. both ship a "search"),
// so the server name is folded in rather than trusting tool names alone to
// be unique.
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function qualifiedToolName(server: string, tool: string): string {
  return sanitizeName(`mcp__${server}__${tool}`).slice(0, 64)
}

// OpenAI's Responses API caps function names; sanitizeName/slicing above can
// theoretically collide two distinct tools onto the same name (a 64+ char
// name truncated, or two tools whose only difference sanitizes away). Rather
// than silently dropping the second one via ToolRegistry.register overwriting
// the first, number the collision so both remain callable.
function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  for (let n = 2; ; n++) {
    const candidate = `${name}_${n}`.slice(0, 64)
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

// Flatten an MCP CallToolResult's content array to the plain text dcode's
// tools otherwise return. Text parts pass through; anything dcode can't
// render as text (images, audio, a blob resource) is described, not dropped
// silently or dumped as raw base64 into the model's context.
function contentToText(content: CallToolResult['content']): string {
  const parts = content.map((c) => {
    if (c.type === 'text') return c.text
    if (c.type === 'resource') {
      const r = c.resource
      // TextResourceContents carries `text`; BlobResourceContents carries a
      // base64 blob — no `type` discriminant, so tell them apart by shape.
      return 'text' in r ? r.text : `(resource ${r.uri}; not shown)`
    }
    return `(${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}; not shown)`
  })
  const text = parts.filter(Boolean).join('\n\n')
  return text || '(no content)'
}

function wrapMcpTool(
  name: string,
  server: string,
  tool: Tool,
  client: Client,
): ToolDefinition {
  return defineTool({
    name,
    description:
      tool.description ?? `MCP tool "${tool.name}" from server "${server}"`,
    parameters: mcpArgsSchema,
    jsonSchema: tool.inputSchema as Record<string, unknown>,
    // MCP's `readOnlyHint` annotation lets a server declare a tool read-only,
    // so treat it like dcode's own `parallel` flag and batch those calls.
    // Everything else stays sequential (the safe default): MCP tools are
    // third-party with no dcode-side guarantee of read-only behavior.
    parallel: tool.annotations?.readOnlyHint ?? false,
    async execute(args, ctx: ToolContext) {
      // Bounded like fetchSafely: ctx.signal alone only covers a parent
      // cancellation, so without toolTimeout a server that never answers leaves
      // the socket and its pending-response entry open after runTool has
      // abandoned the promise. Which of the two fired is deliberately not
      // reported — both surface as the same deadline error from runTool.
      const timeoutSignal = AbortSignal.timeout(ctx.config.toolTimeout)
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal])
        : timeoutSignal
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        { signal },
      )
      // callTool's return is a union of modern CallToolResult and the legacy
      // CompatibilityCallToolResult, and both members carry a
      // `[x: string]: unknown` index signature — so property access here is
      // typed `unknown`. The schema union is authoritative on `content`'s
      // shape, so cast to it rather than hand-rolling a parallel type.
      const text = contentToText(
        (result.content ?? []) as CallToolResult['content'],
      )
      // isError is the MCP protocol's own way of reporting a tool-level
      // failure (bad args, the tool's own logic failing) inside a normal
      // result rather than a JSON-RPC error — surface it as a thrown error so
      // it takes the same ok:false path through runTool as every other
      // tool's failures, instead of reading as a successful call.
      if (result.isError) throw new Error(text)
      return text
    },
  })
}

async function connectOne(
  name: string,
  cfg: McpServerConfig,
  logger: Logger,
): Promise<Client> {
  const transport = makeTransport(name, cfg)
  // Piped rather than the SDK's default "inherit": a misbehaving stdio
  // server's stderr would otherwise land directly on dcode's own stderr,
  // indistinguishable from dcode's own diagnostics. Routed through the debug
  // log instead (StdioServerParameters.stderr set to 'pipe' in makeTransport
  // is what makes this stream exist), so it's visible under --verbose but
  // silent by default — the stream exists as soon as the transport is
  // constructed, so attaching here (before connect/spawn) can't miss data.
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) logger.debug('mcp:%s: %s', name, line)
      }
    })
  }
  const client = new Client(
    { name: 'dcode', version: getVersion() },
    { capabilities: {} },
  )
  await client.connect(transport, {
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  })
  return client
}

// One server's full connect lifecycle — connect, list tools, adapt each into
// a ToolDefinition — collapsed into a single result instead of three outer
// arrays (clients/tools/servers) mutated from inside a loop: the caller below
// just aggregates a list of these, so "did this server come up, and what did
// it contribute" is answered in one place per server rather than tracked
// across three.
interface ServerConnectResult {
  status: McpServerStatus
  client?: Client
  tools: ToolDefinition[]
}

async function connectServer(
  name: string,
  cfg: McpServerConfig,
  logger: Logger,
  used: Set<string>,
): Promise<ServerConnectResult> {
  // `enabled: false` (the default — see schema.ts) skips the connection
  // attempt entirely and is recorded as 'disabled' rather than 'failed' so
  // `/mcp` can tell "off on purpose" apart from "broken".
  if (!cfg.enabled) {
    return { status: { name, status: 'disabled', toolCount: 0 }, tools: [] }
  }
  let client: Client
  try {
    client = await connectOne(name, cfg, logger)
  } catch (err) {
    const error = errorMessage(err)
    logger.warn('mcp: failed to connect "%s": %s', name, error)
    return {
      status: { name, status: 'failed', toolCount: 0, error },
      tools: [],
    }
  }
  try {
    const listed = await client.listTools()
    const tools = listed.tools.map((t) => {
      const toolName = uniqueName(used, qualifiedToolName(name, t.name))
      return wrapMcpTool(toolName, name, t, client)
    })
    logger.debug('mcp: connected "%s" (%d tools)', name, listed.tools.length)
    return {
      status: { name, status: 'connected', toolCount: listed.tools.length },
      client,
      tools,
    }
  } catch (err) {
    // Connected but listTools failed: still return `client` so it gets
    // closed on shutdown — the connection itself is real, only listing its
    // tools failed.
    const error = errorMessage(err)
    logger.warn('mcp: "%s" connected but listTools failed: %s', name, error)
    return {
      status: { name, status: 'failed', toolCount: 0, error },
      client,
      tools: [],
    }
  }
}

// Connect every configured server in parallel (independent processes/
// connections; one slow or unreachable server shouldn't delay the others) and
// merge their tools into one list. A server that fails to connect or list
// its tools is logged and skipped — one bad MCP server config must not stop
// dcode from starting, matching how a missing BRAVE_API_KEY degrades
// web_search rather than blocking startup.
export async function connectMcpServers(
  configured: Record<string, McpServerConfig>,
  logger: Logger,
): Promise<McpManager> {
  const used = new Set<string>()
  const results = await Promise.all(
    Object.entries(configured).map(([name, cfg]) =>
      connectServer(name, cfg, logger, used),
    ),
  )
  const clients = results.flatMap((r) => (r.client ? [r.client] : []))

  return {
    tools: results.flatMap((r) => r.tools),
    servers: results.map((r) => r.status),
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
    },
  }
}
