import { z } from 'zod'

const contextSchema = z
  .object({
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
  root: z.string().optional(),
  verbose: z.boolean().default(false),
  color: z.boolean().default(true),
  maxToolIterations: z.number().int().positive().default(16),
  maxHistoryItems: z.number().int().positive().default(100),
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
})
export type Config = z.infer<typeof configSchema>
