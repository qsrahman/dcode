import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { configSchema, type Config } from './schema.ts'

const DEFAULT_CONFIG_FILES = ['dcode.json', '.dcode.json']

export function resolveRoot(config: Pick<Config, 'root'>): string {
  return config.root ?? process.cwd()
}

// Config is resolved with the precedence CLI > env > file > schema defaults.
// A missing default config (dcode.json / .dcode.json) is fine and falls back to
// schema defaults, but an explicit --config path that doesn't exist is an error:
// the user named a file they expect to load, so silence would hide a typo.
export function loadConfig(path?: string): Partial<Config> {
  if (path !== undefined) return readConfigFile(resolve(process.cwd(), path))
  for (const name of DEFAULT_CONFIG_FILES) {
    const abs = resolve(process.cwd(), name)
    if (existsSync(abs)) return readConfigFile(abs)
  }
  return {}
}

function readConfigFile(abs: string): Partial<Config> {
  if (!existsSync(abs)) throw new Error(`Config file not found: ${abs}`)
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

export function mergeConfigs(
  file: Partial<Config>,
  env: Partial<Config>,
  args: ParsedArgs,
): Config {
  const merged: Record<string, unknown> = { ...file, ...env }
  if (args.model) merged.model = args.model
  if (args.noColor) merged.color = false
  if (args.verbose) merged.verbose = true
  return configSchema.parse(merged)
}

export function buildConfig(args: ParsedArgs): Config {
  const file = loadConfig(args.config)
  const env: Partial<Config> = {}
  if (process.env.OPENAI_API_KEY) env.apiKey = process.env.OPENAI_API_KEY
  if (process.env.OPENAI_BASE_URL) env.baseURL = process.env.OPENAI_BASE_URL
  if (process.env.OPENAI_MODEL) env.model = process.env.OPENAI_MODEL
  return mergeConfigs(file, env, args)
}
