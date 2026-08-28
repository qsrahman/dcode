import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { configSchema, type Config } from './schema.ts'

export function resolveRoot(config: Pick<Config, 'root'>): string {
  return config.root ?? process.cwd()
}

// Location of the per-user global config. Defaults to
// ~/.config/dcode/dcode.json (XDG-style) but can be relocated via
// DCODE_CONFIG_HOME (used for testing and for users who prefer another spot).
export function globalConfigPath(): string {
  const base = process.env.DCODE_CONFIG_HOME
    ? resolve(process.env.DCODE_CONFIG_HOME)
    : resolve(homedir(), '.config', 'dcode')
  return join(base, 'dcode.json')
}

// Config precedence (highest wins): CLI flags > env (OPENAI_*) > global
// (~/.config/dcode/dcode.json) > schema defaults. An explicit --config <path> is
// read instead of the global file (and a missing path is an error, so a typo
// doesn't fail silently). dcode is a globally installed personal tool, so there
// is no repo-local config discovery.
export function loadConfig(path?: string): Partial<Config> {
  const target =
    path !== undefined ? resolve(process.cwd(), path) : globalConfigPath()
  if (!existsSync(target)) {
    if (path !== undefined) throw new Error(`Config file not found: ${target}`)
    return {}
  }
  return readConfigFile(target)
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
  if (process.env.BRAVE_API_KEY) env.brave = process.env.BRAVE_API_KEY
  return mergeConfigs(file, env, args)
}
