import { z } from 'zod'

const mcpServerSchema = z
  .object({
    name: z.string(),
    transport: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('stdio'),
          command: z.string(),
          args: z.array(z.string()).default([]),
          env: z.record(z.string(), z.string()).optional(),
          cwd: z.string().optional(),
        })
        .strict(),
      z.object({ type: z.literal('http'), url: z.string() }).strict(),
    ]),
    trust: z.boolean().default(false),
  })
  .strict()

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
  mcp: z.array(mcpServerSchema).default([]),
})
export type AppConfig = z.infer<typeof configSchema>
