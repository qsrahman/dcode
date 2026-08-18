import { z } from 'zod'

const modeSchema = z.enum(['interactive', 'auto', 'plan'])

const permissionRuleSchema = z.enum(['allow', 'deny', 'ask'])

const permissionsSchema = z
  .object({
    mode: modeSchema.default('interactive'),
    rules: z.record(z.string(), permissionRuleSchema).default({}),
  })
  .strict()

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

export const appConfigSchema = z.object({
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
  permissions: permissionsSchema.default({ mode: 'interactive', rules: {} }),
  mcp: z.array(mcpServerSchema).default([]),
})
export type AppConfig = z.infer<typeof appConfigSchema>
