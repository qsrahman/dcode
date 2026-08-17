import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { appConfigSchema, type AppConfig } from './schema.ts'

const DEFAULT_CONFIG_FILES = ['dcode.json', '.dcode.json']

// Config is resolved with the precedence CLI > env > file > schema defaults.
export function loadConfig(path?: string): Partial<AppConfig> {
  const candidates = path ? [path] : DEFAULT_CONFIG_FILES
  for (const name of candidates) {
    const abs = resolve(process.cwd(), name)
    if (existsSync(abs)) {
      const raw = readFileSync(abs, 'utf8')
      return appConfigSchema.partial().parse(JSON.parse(raw))
    }
  }
  return {}
}

export function mergeConfigs(
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
  if (args.noColor) merged.color = false
  if (args.verbose) merged.verbose = true
  merged.permissions = {
    ...(file.permissions ?? {}),
    mode: mode ?? file.permissions?.mode,
  }
  return appConfigSchema.parse(merged)
}

export function buildConfig(args: ParsedArgs): AppConfig {
  const file = loadConfig(args.config)
  const env: Partial<AppConfig> = {}
  if (process.env.OPENAI_API_KEY) env.apiKey = process.env.OPENAI_API_KEY
  if (process.env.OPENAI_BASE_URL) env.baseURL = process.env.OPENAI_BASE_URL
  if (process.env.OPENAI_DEFAULT_MODEL)
    env.model = process.env.OPENAI_DEFAULT_MODEL
  return mergeConfigs(file, env, args)
}
