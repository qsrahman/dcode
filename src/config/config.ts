import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { CliOptions } from '../cli/args.ts'
import { configSchema, type Config } from './schema.ts'
import { errorMessage } from '../util/log.ts'

// Location of the per-user global config, following the XDG Base Directory
// spec: `$XDG_CONFIG_HOME/dcode/dcode.json`, with $XDG_CONFIG_HOME defaulting
// to ~/.config. A relative $XDG_CONFIG_HOME is ignored (the spec requires an
// absolute path), so a stray value can't point the config at a cwd-relative
// path.
export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(base, 'dcode', 'dcode.json')
}

// The OpenAI SDK appends resource paths (`/responses`, `/models`) to `baseURL`,
// so the configured value must include the API-version prefix (e.g.
// `http://localhost:11434/v1`, `https://api.openai.com/v1`). Ensure that prefix
// is present so both bare origins and explicit `/v1` work.
export function normalizeBaseURL(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

// This file can hold apiKey/braveApiKey, and /key writes it 0o600. A config
// created by hand, copied from a repo, or restored from a backup often isn't —
// which on a shared machine means any local user can read the key. Warn rather
// than fail: the key still works, and refusing to start would be worse than
// saying so. chmod is the fix rather than `/key set`, which would make the user
// re-type the secret it was trying to protect.
//
// Windows is skipped: Node synthesizes mode 0o666 there from the read-only
// attribute and permissions are ACL-based, so every file would look world-
// readable and the warning would fire on every run.
function permissionsWarning(target: string): string | undefined {
  if (process.platform === 'win32') return undefined
  let mode: number
  try {
    mode = statSync(target).mode & 0o777
  } catch {
    return undefined
  }
  if ((mode & 0o077) === 0) return undefined
  return `${target} is readable by other users (mode 0${mode.toString(8)}); if it holds an API key, run: chmod 600 ${target}`
}

// Read the effective config file: an explicit --config <path> (a missing one is
// an error, so a typo doesn't fail silently) or, when none is given, the global
// XDG file (absent → schema defaults via `{}`). dcode is a globally installed
// personal tool, so there is no repo-local config discovery.
//
// `onWarning` receives non-fatal problems with the file itself (see
// permissionsWarning). A callback rather than a returned list so this stays a
// pure function of its inputs for the tests.
export function readConfigFile(
  path?: string,
  onWarning?: (message: string) => void,
): Partial<Config> {
  const target =
    path !== undefined ? resolve(process.cwd(), path) : globalConfigPath()
  if (!existsSync(target)) {
    if (path !== undefined) throw new Error(`Config file not found: ${target}`)
    return {}
  }
  const raw = readFileSync(target, 'utf8')
  const permissionWarning = permissionsWarning(target)
  if (permissionWarning) onWarning?.(permissionWarning)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${target}: ${errorMessage(err)}`)
  }
  try {
    // .strict() catches typo'd keys (including inside `context`) — every field
    // tolerates absence via .optional()/.default(), so unknown keys are rejected
    // rather than silently ignored.
    return configSchema.strict().parse(json)
  } catch (err) {
    throw new Error(`Failed to load config ${target}: ${errorMessage(err)}`)
  }
}

// Build the effective config from all sources. Precedence (highest wins): CLI
// flags > env (OPENAI_*) > config file > schema defaults, layered by spreading
// file then env into one object and applying args last.
//
// `onWarning` is forwarded to readConfigFile, so the file's own problems are
// reported without this function logging (buildConfig is otherwise pure, and
// tests exercise it directly).
export function buildConfig(
  args: CliOptions,
  onWarning?: (message: string) => void,
): Config {
  const merged: Record<string, unknown> = {
    ...readConfigFile(args.config, onWarning),
  }
  if (process.env.OPENAI_API_KEY) merged.apiKey = process.env.OPENAI_API_KEY
  if (process.env.OPENAI_BASE_URL) merged.baseURL = process.env.OPENAI_BASE_URL
  if (process.env.OPENAI_MODEL) merged.model = process.env.OPENAI_MODEL
  if (process.env.BRAVE_API_KEY) merged.braveApiKey = process.env.BRAVE_API_KEY
  if (process.env.BRAVE_ENDPOINT)
    merged.braveEndpoint = process.env.BRAVE_ENDPOINT
  if (typeof merged.baseURL === 'string') {
    merged.baseURL = normalizeBaseURL(merged.baseURL)
  }
  if (args.model) merged.model = args.model
  if (args.noColor) merged.color = false
  // The parse is non-strict (unlike readConfigFile's .strict()): the file was
  // already strict-parsed and env keys are a fixed known set, so nothing
  // unknown can reach here except via a bug in this function. verbose is
  // CLI-only (not in configSchema), so attach it after parsing — the schema
  // would strip it, and the strict file parse rejects it as a persisted key.
  return { ...configSchema.parse(merged), verbose: args.verbose === true }
}

// Cross-field problems that degrade behaviour but shouldn't stop startup, so
// they warn instead of failing schema validation. `context.reserved` is
// headroom for both the model's own output and the compaction call, so
// maxTokens (the ceiling on that output) should leave real room under it.
export function configWarnings(config: Config): string[] {
  const warnings: string[] = []
  if (config.maxTokens >= config.context.reserved) {
    warnings.push(
      `maxTokens (${config.maxTokens}) should be less than context.reserved (${config.context.reserved}); a long response can crowd out the headroom compaction needs`,
    )
  }
  return warnings
}
