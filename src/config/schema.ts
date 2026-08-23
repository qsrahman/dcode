import { z } from 'zod'

export const configSchema = z.object({
  model: z.string().default('gpt-5'),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  root: z.string().optional(),
  verbose: z.boolean().default(false),
  color: z.boolean().default(true),
  maxToolIterations: z.number().int().positive().default(16),
  maxHistoryItems: z.number().int().positive().default(100),
  maxToolOutputBytes: z.number().int().positive().default(32768),
  maxTokens: z.number().int().positive().default(8192),
  maxRetries: z.number().int().nonnegative().default(3),
  toolTimeout: z.number().int().positive().default(30000),
  // Directory names skipped by the recursive tools (grep/glob). These flood
  // results and are almost never what the model wants to search.
  ignore: z.array(z.string()).default(['.git', 'node_modules']),
  // Context-window management: keep the request within `window` tokens by
  // pruning old tool outputs (cheap, no model call) and, when still over,
  // summarizing the oldest history into a single developer message (compact).
  // `window` must match the model's real context limit; `reserved` is headroom
  // kept free for the model's output + the compaction call.
  context: z
    .object({
      auto: z.boolean().default(true),
      window: z.number().int().positive().default(200000),
      reserved: z.number().int().nonnegative().default(20000),
      keepTokens: z.number().int().positive().default(15000),
      prune: z.boolean().default(true),
    })
    .refine(
      (ctx) => ctx.keepTokens < ctx.window - ctx.reserved,
      'keepTokens must be less than window - reserved to allow headroom for compaction',
    )
    .default({
      auto: true,
      window: 200000,
      reserved: 20000,
      keepTokens: 15000,
      prune: true,
    }),
})
export type AppConfig = z.infer<typeof configSchema>
