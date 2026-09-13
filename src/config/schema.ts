import { z } from 'zod'

// One configured MCP server, either spawned locally (over stdio) or reached
// over HTTP ("remote"). `type` picks the transport; when the config omits
// it, `inferMcpType` below fills it in from whichever of `command`/`url` is
// present, so the common case doesn't have to spell out the obvious — the
// same convention Claude Code's own `.mcp.json` uses.
const mcpLocalServerSchema = z
  .object({
    type: z.literal('local'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    // Merged on top of the tool process's own filtered env (safeEnv(), same
    // ambient-secret stripping every other spawn in tools/local/ gets) rather
    // than replacing it — an MCP server commonly needs its own explicitly
    // configured secret (its own API key), which is exactly what this field
    // is for, while still inheriting PATH/HOME/etc.
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()

const mcpRemoteServerSchema = z
  .object({
    type: z.literal('remote'),
    url: z.string(),
    // Static headers only (e.g. a bearer token) — no OAuth flow. A remote
    // server that requires interactive auth isn't supported yet.
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()

function inferMcpType(val: unknown): unknown {
  if (val && typeof val === 'object' && !('type' in val)) {
    const v = val as Record<string, unknown>
    if (typeof v.url === 'string') return { ...v, type: 'remote' }
    if (typeof v.command === 'string') return { ...v, type: 'local' }
  }
  return val
}

const mcpServerSchema = z.preprocess(
  inferMcpType,
  z.discriminatedUnion('type', [mcpLocalServerSchema, mcpRemoteServerSchema]),
)

export type McpServerConfig = z.infer<typeof mcpServerSchema>

const contextSchema = z
  .object({
    // Proactive context management before each request: prune old tool outputs,
    // then summarize the oldest history once over `compactAt` of the budget.
    // On by default and recommended.
    //
    // Setting this false is a deliberate opt-out with real consequences, now
    // that the fixed item-count cap (`maxHistoryItems`/`trimHistory`) has been
    // removed — automatic compaction is the ONLY thing that bounds history:
    //   - History grows unbounded turn over turn. Each request is larger (more
    //     tokens, higher cost, higher latency) than the last.
    //   - Nothing shrinks it *proactively*. Recovery becomes purely reactive:
    //     a request eventually overflows the model's window, and `onOverflow`
    //     (which ignores this flag) prunes/compacts and retries once — so you
    //     pay for a failed oversized request *plus* a compaction, instead of
    //     compacting cheaply ahead of time.
    //   - If that reactive compaction can't make progress three times running,
    //     the circuit breaker trips and further requests just fail with a
    //     context-length error until the session is reset.
    // In short: `auto: false` trades steady, cheap, proactive compaction for
    // unbounded growth punctuated by expensive reactive recovery. Only disable
    // it for short-lived or one-shot sessions that never approach the window.
    auto: z.boolean().default(true),
    window: z.number().int().positive().default(200000),
    reserved: z.number().int().nonnegative().default(20000),
    keepTokens: z.number().int().positive().default(15000),
    prune: z.boolean().default(true),
    compactAt: z.number().min(0).max(1).default(0.85),
  })
  .strict()
  .refine(
    (ctx) => ctx.keepTokens < ctx.window - ctx.reserved,
    'keepTokens must be less than window - reserved to allow headroom for compaction',
  )

export const configSchema = z.object({
  model: z.string().default('gpt-5.4-mini'),
  // OpenAI-compatible endpoint. dcode appends the resource path (`/responses`,
  // `/models`) to this value, so include the API-version prefix (e.g.
  // `http://localhost:11434/v1` for Ollama, `https://api.openai.com/v1` for
  // OpenAI). A missing `/v1` is added automatically during config merge.
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  brave: z.string().optional(),
  // Override for Brave's search endpoint (tests, proxies). Resolved the same
  // way as `brave` itself: through config, not read from process.env at the
  // call site, so /key-style runtime overrides and CLI>env>file precedence
  // apply to it too instead of it being frozen at module load.
  braveEndpoint: z.string().optional(),
  color: z.boolean().default(true),
  maxToolIterations: z.number().int().positive().default(16),
  maxToolOutputBytes: z.number().int().positive().default(32768),
  maxTokens: z.number().int().positive().default(8192),
  maxRetries: z.number().int().nonnegative().default(3),
  toolTimeout: z.number().int().positive().default(30000),
  // When true, responses are stored server-side so a later turn could chain via
  // `previous_response_id`. Off by default: server storage isn't available on
  // local/compatible endpoints and OpenAI's 30-day retention is undesirable here.
  stateful: z.boolean().default(false),
  // Directory names skipped by the recursive tools (grep/glob). These flood
  // results and are almost never what the model wants to search.
  ignore: z.array(z.string()).default(['.git', 'node_modules']),
  // The default is derived by parsing `{}` through the schema rather than
  // restating every field default a second time. zod hands a `.default()`
  // value back verbatim — it does not re-parse it — so the literal object
  // that used to live here was a full second copy of the defaults above, and
  // the two could silently diverge: omitting `context` entirely would yield
  // the stale literal while writing `"context": {}` would yield the real
  // field defaults. Same values, two sources of truth, no error either way.
  //
  // Context-window management: keep the request within `window` tokens by
  // pruning old tool outputs (cheap, no model call) and, when still over,
  // summarizing the oldest history into a single developer message (compact).
  // `window` must match the model's real context limit; `reserved` is headroom
  // kept free for the model's output + the compaction call. `compactAt` is the
  // fraction of that budget at which compaction kicks in *proactively* (before a
  // context-length error), so the model stays comfortably under the limit.
  context: contextSchema.default(() => contextSchema.parse({})),
  // Named MCP servers to connect to at startup (decision I: session-lived,
  // closed on exit/SIGINT — see tools/mcp/manager.ts). Empty by default: no
  // startup latency or spawned processes unless the user opts in.
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
})

// `verbose` is a CLI-only runtime flag (`--verbose`), never a persisted config
// key: it lives on the runtime Config type but not in `configSchema`, so the
// strict `dcode.json` parse rejects a `"verbose"` key while `buildConfig`
// still sets it from argv. `root` was removed entirely — the working directory
// is always `process.cwd()`.
export type Config = z.infer<typeof configSchema> & { verbose: boolean }
