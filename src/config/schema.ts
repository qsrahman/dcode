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
})
export type AppConfig = z.infer<typeof configSchema>
