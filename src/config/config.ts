import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { configSchema, type AppConfig } from './schema.ts'

const DEFAULT_CONFIG_FILES = ['dcode.json', '.dcode.json']

export function resolveRoot(config: Pick<AppConfig, 'root'>): string {
  return config.root ?? process.cwd()
}

// Config is resolved with the precedence CLI > env > file > schema defaults.
export function loadConfig(path?: string): Partial<AppConfig> {
  const candidates = path ? [path] : DEFAULT_CONFIG_FILES
  for (const name of candidates) {
    const abs = resolve(process.cwd(), name)
    if (existsSync(abs)) {
      const raw = readFileSync(abs, 'utf8')
      try {
        // .strict() (not .partial()) catches typo'd keys — every field already
        // tolerates absence via .optional()/.default(), so .partial() was a
        // no-op that also silently accepted unrecognized keys.
        return configSchema.strict().parse(JSON.parse(raw))
      } catch (err) {
        throw new Error(
          `Failed to load config ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
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
  const mode =
    args.mode ?? (args.auto ? 'auto' : args.plan ? 'plan' : undefined)

  const merged: Record<string, unknown> = { ...file, ...env }
  if (args.model) merged.model = args.model
  if (args.noColor) merged.color = false
  if (args.verbose) merged.verbose = true
  merged.permissions = {
    ...(file.permissions ?? {}),
    ...(mode !== undefined && { mode }),
  }
  return configSchema.parse(merged)
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
