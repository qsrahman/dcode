import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
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
// ToolRegistry as dcode's built-in tools — the agent loop, task tool, and
// sub-agent filtering all treat them identically; nothing downstream needs to
// know a tool came from MCP rather than tools/local/.

const CONNECT_TIMEOUT_MS = 10_000

export interface McpServerStatus {
  name: string
  status: 'connected' | 'failed'
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

function makeTransport(cfg: McpServerConfig): Transport {
  if (cfg.type === 'http') {
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    })
  }
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    // The server's own configured env layers on top of the filtered ambient
    // env (see exec.ts's safeEnv) rather than replacing it: a server commonly
    // needs its own secret (an API key) passed explicitly, which is exactly
    // what `env` in the config is for, while PATH/HOME/etc. still come
    // through and ambient secret-looking vars stay stripped.
    env: { ...safeEnv(), ...(cfg.env ?? {}) },
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

interface McpContentPart {
  type: string
  text?: string
  mimeType?: string
  resource?: { uri?: string; text?: string }
}

// Flatten an MCP CallToolResult's content array to the plain text dcode's
// tools otherwise return. Text parts pass through; anything dcode can't
// render as text (images, audio, an opaque binary resource) is described,
// not dropped silently or dumped as raw base64 into the model's context.
function contentToText(content: McpContentPart[]): string {
  const parts = content.map((c) => {
    if (c.type === 'text') return c.text ?? ''
    if (c.type === 'resource') {
      if (typeof c.resource?.text === 'string') return c.resource.text
      return `(resource ${c.resource?.uri ?? 'unknown'}; not shown)`
    }
    return `(${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}; not shown)`
  })
  const text = parts.filter(Boolean).join('\n\n')
  return text || '(no content)'
}

function wrapMcpTool(
  name: string,
  server: string,
  tool: { name: string; description?: string; inputSchema: unknown },
  client: Client,
): ToolDefinition {
  return defineTool({
    name,
    description:
      tool.description ?? `MCP tool "${tool.name}" from server "${server}"`,
    parameters: mcpArgsSchema,
    jsonSchema: tool.inputSchema as Record<string, unknown>,
    // MCP tools are third-party and side-effecting by default (the protocol
    // doesn't distinguish read-only vs mutating tools the way dcode's own
    // `parallel` flag does), so run them sequentially like every other
    // tool without a documented read-only guarantee.
    parallel: false,
    async execute(args, ctx: ToolContext) {
      const result = await client.callTool(
        { name: tool.name, arguments: args as Record<string, unknown> },
        undefined,
        { signal: ctx.signal },
      )
      const text = contentToText((result.content ?? []) as McpContentPart[])
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
  const transport = makeTransport(cfg)
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
  const clients: Client[] = []
  const tools: ToolDefinition[] = []
  const servers: McpServerStatus[] = []
  const used = new Set<string>()

  await Promise.all(
    Object.entries(configured).map(async ([name, cfg]) => {
      let client: Client
      try {
        client = await connectOne(name, cfg, logger)
      } catch (err) {
        const error = errorMessage(err)
        logger.warn('mcp: failed to connect "%s": %s', name, error)
        servers.push({ name, status: 'failed', toolCount: 0, error })
        return
      }
      clients.push(client)
      try {
        const listed = await client.listTools()
        for (const t of listed.tools) {
          const toolName = uniqueName(used, qualifiedToolName(name, t.name))
          tools.push(wrapMcpTool(toolName, name, t, client))
        }
        servers.push({
          name,
          status: 'connected',
          toolCount: listed.tools.length,
        })
        logger.debug(
          'mcp: connected "%s" (%d tools)',
          name,
          listed.tools.length,
        )
      } catch (err) {
        const error = errorMessage(err)
        logger.warn('mcp: "%s" connected but listTools failed: %s', name, error)
        servers.push({ name, status: 'failed', toolCount: 0, error })
      }
    }),
  )

  return {
    tools,
    servers,
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
    },
  }
}
