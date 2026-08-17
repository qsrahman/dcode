import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { appConfigSchema, type AppConfig } from './schema.ts'

const DEFAULT_CONFIG_NAMES = ['dcode.json', '.dcode.json']

// Config is resolved with the precedence CLI > env > file > schema defaults.
export function loadConfigFile(path?: string): Partial<AppConfig> {
  const candidates = path ? [path] : DEFAULT_CONFIG_NAMES
  for (const name of candidates) {
    const abs = resolve(process.cwd(), name)
    if (existsSync(abs)) {
      const raw = readFileSync(abs, 'utf8')
      return appConfigSchema.partial().parse(JSON.parse(raw))
    }
  }
  return {}
}

export function mergeConfig(
  file: Partial<AppConfig>,
  env: Partial<AppConfig>,
  args: ParsedArgs,
): AppConfig {
  // --mode is validated by the schema; --auto/--plan are shorthands.
  let mode: string | undefined
  if (args.mode !== undefined) {
    mode = args.mode
  } else if (args.auto) {
    mode = 'auto'
  } else if (args.plan) {
    mode = 'plan'
  }

  const merged: Record<string, unknown> = { ...file, ...env }
  if (args.model) merged.model = args.model
  if (args.noStream) merged.stream = false
  if (args.noColor) merged.color = false
  if (args.verbose) merged.verbose = true
  merged.permissions = {
    ...(file.permissions ?? {}),
    mode: mode ?? file.permissions?.mode,
  }
  return appConfigSchema.parse(merged)
}

export function buildConfig(args: ParsedArgs): AppConfig {
  const file = loadConfigFile(args.config)
  const env: Partial<AppConfig> = {}
  if (process.env.OPENAI_API_KEY) env.apiKey = process.env.OPENAI_API_KEY
  if (process.env.OPENAI_BASE_URL) env.baseURL = process.env.OPENAI_BASE_URL
  if (process.env.DCODE_MODEL) env.model = process.env.DCODE_MODEL
  return mergeConfig(file, env, args)
}
