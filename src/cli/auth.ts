import { password, isCancel } from '@clack/prompts'
import type { Config } from '../config/schema.ts'
import type { Logger } from '../util/log.ts'
import { normalizeBaseURL } from '../config/config.ts'
import { setGlobalKey } from './keys.ts'

// 'invalid' is the only outcome that blocks startup — a definite 401/403 auth
// rejection. 'valid' is a confirmed 2xx from the configured endpoint.
// 'unknown' covers everything else: a network error, a timeout, or any other
// status (a non-2xx-non-401/403, e.g. a 404 from an endpoint that doesn't
// expose /models, or a 429 rate limit) — none of these prove the key is
// wrong, but none confirm it's right either, so callers shouldn't treat it
// as verified (e.g. before persisting a freshly entered key).
export type ApiKeyStatus = 'valid' | 'invalid' | 'unknown'

// No real endpoint should take this long to answer a single /models list;
// bound it so a stalled network can't hang startup indefinitely.
const VALIDATE_TIMEOUT_MS = 10_000

// Cheap liveness/auth check: a single models listing with the configured key.
export async function validateApiKey(config: Config): Promise<ApiKeyStatus> {
  const base = normalizeBaseURL(config.baseURL ?? 'https://api.openai.com')
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) return 'invalid'
    return res.status >= 200 && res.status < 300 ? 'valid' : 'unknown'
  } catch {
    // Includes the AbortSignal.timeout firing — treated the same as any
    // other network failure: don't block startup, but don't call it verified.
    return 'unknown'
  }
}

const DEFAULT_ENDPOINT = 'https://api.openai.com/'

const NO_KEY_HELP = `OPENAI_API_KEY is not set — dcode needs an OpenAI-compatible API key to run.

Provide it one of these ways:
  shell profile:  echo 'export OPENAI_API_KEY=sk-...' >> ~/.zshrc
  interactive:    paste it when dcode prompts on startup (saved to global config)
  /key command:   run  /key set openai sk-...  in the REPL
Then restart dcode if you used the shell profile.
`

// First-run key bootstrap: if no API key is available from env or config,
// prompt once with masked input (the value is a secret). Only on a TTY, so
// piped or one-shot use never blocks on a keypress that isn't coming — @clack's
// password() would otherwise wait forever on non-interactive stdin. Returns the
// entered key, or '' if skipped/cancelled/empty.
async function promptForApiKey(): Promise<string> {
  if (!process.stdin.isTTY) return ''
  const entered = await password({
    message:
      'No API key found. Paste your OpenAI-compatible key (saved to the global config):',
  })
  if (isCancel(entered) || !entered) return ''
  return entered.trim()
}

// The whole startup auth path, in one place: find a key (prompting on a TTY
// when there's none), check it, and persist a freshly entered one.
//
// `interactive` is false for one-shot runs, which keep the hard failure —
// there is no TTY to prompt on. A key confirmed *invalid* (401/403) is never
// stored, so a bad paste can't get stuck in the global config; an
// indeterminate result still stores it, with a warning, because a network
// blip or an endpoint without /models is not evidence the key is wrong.
//
// Returns the fatal message to print, or null when startup may proceed —
// rather than calling process.exit itself, so the caller keeps control of
// how the process ends and this stays testable.
export async function ensureApiKey(
  config: Config,
  logger: Logger,
  interactive: boolean,
): Promise<string | null> {
  let promptedKey = ''
  if (interactive && !config.apiKey) {
    promptedKey = await promptForApiKey()
    if (promptedKey) config.apiKey = promptedKey
  }
  if (!config.apiKey) return NO_KEY_HELP

  const endpoint = config.baseURL ?? DEFAULT_ENDPOINT
  const status = await validateApiKey(config)
  if (status === 'invalid') {
    return (
      `OPENAI_API_KEY is invalid (authentication failed) — dcode could not ` +
      `authenticate with the configured endpoint (${endpoint}).\n\n` +
      'Check the value in your shell profile (.zshrc/.bashrc) or dcode.json config, then\n' +
      'restart dcode.\n'
    )
  }
  if (promptedKey) {
    if (status === 'unknown') {
      logger.warn(
        "could not verify the key against %s (network error, timeout, or the endpoint doesn't expose /models) — saving it unverified. If it turns out to be wrong, run /key set openai <value> to replace it.",
        endpoint,
      )
    }
    setGlobalKey('apiKey', promptedKey)
  }
  return null
}
