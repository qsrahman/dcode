import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ParsedArgs } from '../cli/args.ts'
import { configSchema, type Config } from './schema.ts'

const DEFAULT_CONFIG_FILES = ['dcode.json', '.dcode.json']

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

// Config is resolved with the precedence CLI > env > file > schema defaults.
// A local config (dcode.json / .dcode.json in the working directory) wins over
// the global config; an explicit --config path that doesn't exist is an error:
// the user named a file they expect to load, so silence would hide a typo.
export function loadConfig(path?: string): Partial<Config> {
  if (path !== undefined) return readConfigFile(resolve(process.cwd(), path))
  let local: Partial<Config> | undefined
  for (const name of DEFAULT_CONFIG_FILES) {
    const abs = resolve(process.cwd(), name)
    if (existsSync(abs)) {
      local = readConfigFile(abs)
      break
    }
  }
  const gpath = globalConfigPath()
  const global = existsSync(gpath) ? readConfigFile(gpath) : undefined
  if (local && global) return { ...global, ...local }
  return local ?? global ?? {}
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
