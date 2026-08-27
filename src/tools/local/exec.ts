import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolContext } from '../../agent/types.ts'
import { CHILD_MAX_BUFFER } from './constants.ts'

const execFileAsync = promisify(execFile)

// Don't let child processes inherit secret-looking environment variables
// (API keys, tokens): `run_shell` could otherwise `printenv` them straight
// into tool output and the model context. Keep ordinary runtime vars (PATH,
// HOME, LANG, …) so commands still work.
const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE/i
function safeEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SECRET_RE.test(k)) env[k] = v
  }
  return env
}

// Shared execFile wrapper for run_shell/git: applies the tool timeout/signal/
// buffer ceiling and formats success and failure the same way, surfacing
// stdout+stderr either way instead of losing them to err.message on failure.
export async function runExec(
  cmd: string,
  args: string[],
  ctx: ToolContext,
  opts: { shell?: boolean } = {},
): Promise<string> {
  try {
    // `timeout` and `signal` both kill the child directly: the runTool
    // deadline/abort race only rejects the promise, which would otherwise
    // leave the process running and holding the event loop open.
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: ctx.root,
      shell: opts.shell,
      timeout: ctx.config.toolTimeout,
      maxBuffer: CHILD_MAX_BUFFER,
      signal: ctx.signal,
      env: safeEnv(),
    })
    return `${stdout}${stderr}`.trim() || '(no output)'
  } catch (err) {
    // execFile rejects on a non-zero exit (or timeout) with stdout/stderr
    // attached to the error rather than returned — surface them the same
    // way a successful run does instead of losing stdout to err.message.
    const e = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
      signal?: string | null
      killed?: boolean
    }
    // Output above the buffer ceiling is discarded by Node, so a plain
    // maxBuffer error with no captured output would be cryptic — say what happened.
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(
        `command output exceeded ${CHILD_MAX_BUFFER} bytes; narrow the command (e.g. pipe through head or grep)`,
      )
    }
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
    // A non-zero exit carries a numeric code; a timeout (execFile kills the
    // child, code null + killed) or an abort (ABORT_ERR from ctx.signal)
    // shouldn't read as "exit <code>".
    let label: string
    if (typeof e.code === 'number') label = `exit ${e.code}`
    else if (e.code === 'ABORT_ERR') label = 'aborted'
    else if (e.killed || e.signal) label = 'timed out'
    else label = `${e.code ?? 'unknown'}`
    throw new Error(`${label}: ${out || '(no output)'}`)
  }
}
