import { z } from 'zod/v4'

// Shared http(s)-only URL validator (parseable, scheme restricted to
// http/https). Used by config's baseURL and braveEndpoint here, and by
// web_fetch's url parameter — one
// definition so the three can't drift.
export function httpUrl(message?: string) {
  return z.url({
    protocol: /^https?$/,
    ...(message ? { error: message } : {}),
  })
}

// One configured MCP server, either spawned locally (over stdio) or reached
// over HTTP ("remote"). `type` picks the transport; when the config omits
// it, `inferMcpType` below fills it in from whichever of `command`/`url` is
// present, so the common case doesn't have to spell out the obvious — the
// same convention Claude Code's own `.mcp.json` uses.
//
// `enabled` defaults to `false`: a server entry sitting in the *global*
// config is visible (and, if misconfigured, spawnable/dialable) from every
// project dcode runs in, so adding one shouldn't silently start connecting
// to it — the opt-in has to be explicit. This also makes it cheap to keep a
// server's config around without it running: toggle `enabled` instead of
// deleting and re-adding the whole entry.
const enabledField = z.boolean().default(false)

const mcpLocalServerSchema = z
  .object({
    type: z.literal('local'),
    enabled: enabledField,
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
    enabled: enabledField,
    // Deliberately a plain string, not httpUrl(): a bad URL must fail only
    // this server (connectOne records it as 'failed'), never abort config
    // loading and with it every other server and the whole session.
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
    //     (which ignores this flag) prunes/compacts and retries — up to three
    //     times — so you pay for a failed oversized request *plus* the
    //     compaction, instead of compacting cheaply ahead of time.
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
  // Validated (httpUrl()) so a typo'd baseURL fails loudly
  // at config load, not as an opaque fetch/SDK error the first time a
  // request is made.
  baseURL: httpUrl().optional(),
  apiKey: z.string().optional(),
  braveApiKey: z.string().optional(),
  // Override for Brave's search endpoint (tests, proxies). Resolved the same
  // way as `braveApiKey` itself: through config, not read from process.env at the
  // call site, so /key-style runtime overrides and CLI>env>file precedence
  // apply to it too instead of it being frozen at module load. Validated
  // (httpUrl()) for the same reason baseURL is: web.ts's `new URL(...)` on
  // this value has no try/catch of its own, so a malformed override should
  // fail here, not as an opaque native TypeError from inside
  // web_search's execute().
  braveEndpoint: httpUrl().optional(),
  color: z.boolean().default(true),
  maxToolIterations: z.number().int().positive().default(16),
  // Floored at the paging reserve rather than at 1: read_file/web_fetch page
  // their output by subtracting NOTE_RESERVE (128) to leave room for the "N of
  // M; offset=… to continue" footer, and a smaller cap makes that budget
  // negative — new Uint8Array(-27) throws a RangeError from inside web_fetch,
  // long after config load. Rejecting it here turns a mid-run crash into a
  // config error naming the constraint. Keep in sync with NOTE_RESERVE in
  // tools/local/fs.ts and tools/local/web.ts.
  maxToolOutputBytes: z.number().int().min(128).default(32768),
  maxTokens: z.number().int().positive().default(8192),
  // Sent to the model on each agent turn only when set (compaction keeps the
  // provider default), so an unset value changes nothing for endpoints that
  // reject the fields. Effort is the main control for how much a reasoning
  // model explores before acting; verbosity controls final-answer length. The
  // effort values mirror the SDK's ReasoningEffort; which ones a model
  // accepts is the provider's call.
  reasoningEffort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional(),
  verbosity: z.enum(['low', 'medium', 'high']).optional(),
  maxRetries: z.number().int().nonnegative().default(3),
  toolTimeout: z.number().int().positive().default(120000),
  // Budget for one whole sub_agent delegation. Separate from `toolTimeout`
  // because a sub-agent runs its own multi-iteration loop — often longer than
  // any single tool call, and in `general` mode that loop can write files. The
  // defect being bounded here is unboundedness, not slowness: with no budget,
  // runTool's deadline abandons the sub-agent promise and the child keeps
  // mutating the repo with no caller left watching. Generous by default, and
  // independent so a slow tool can't cut a delegation's write access short.
  subAgentTimeout: z.number().int().positive().default(600000),
  // When true, responses are stored server-side so a later turn could chain via
  // `previous_response_id`. Off by default: server storage isn't available on
  // local/compatible endpoints and OpenAI's 30-day retention is undesirable here.
  stateful: z.boolean().default(false),
  // When true, built-in tools are sent with `strict: true` and the SDK's strict
  // schema, so an OpenAI endpoint guarantees their arguments match. Off by
  // default: every unused optional argument becomes an explicit `null` the
  // model must write, a new schema costs extra latency on its first request,
  // and endpoints other than OpenAI's may not accept the schema. MCP tools are
  // never made strict.
  strictTools: z.boolean().default(false),
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
