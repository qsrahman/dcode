import { execa } from 'execa'
import type { ExecaError } from 'execa'
import { z } from 'zod'
import type { ToolContext } from '../../agent/types.ts'
import { defineTool } from '../registry.ts'

// Shared child_process buffer ceiling: comfortably above maxToolOutputBytes so
// normal large output is truncated rather than killing the child.
export const CHILD_MAX_BUFFER = 10 * 1024 * 1024

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

// Options every execa call in tools/local/ needs, regardless of which binary
// it spawns (git, a shell, ripgrep, a background process): scope it to the
// working directory, strip secret-looking env vars, and let ctx.signal kill
// it on Ctrl-C. `env` replaces process.env entirely (extendEnv: false)
// rather than merging on top of it — otherwise the vars safeEnv() filtered
// out would come right back in via the merge.
export function baseExecOptions(cwd: string, signal?: AbortSignal) {
  return {
    cwd,
    env: safeEnv(),
    extendEnv: false,
    cancelSignal: signal,
  }
}

// Run a shell command and render success and failure the same way, surfacing
// stdout+stderr either way instead of losing them to error.message on a
// failure. Takes no argv/shell-mode parameters: it grew them for the scoped
// `git` tool, which spawned a binary directly with an argument list, and that
// tool is gone — `run_shell` is the only caller and always shells out.
async function runShell(command: string, ctx: ToolContext): Promise<string> {
  try {
    // `timeout` kills the child on expiry and `cancelSignal` (via
    // baseExecOptions) kills it on ctx.signal firing — both terminate the
    // process directly, so a timed-out or aborted tool call can't leave an
    // orphaned child behind. killDescendants is required for that to
    // actually be prompt in shell mode: a shell often doesn't forward
    // SIGTERM to a running foreground child (e.g. `sleep`) until that child
    // exits on its own, so without it execa would wait out the full
    // forceKillAfterDelay (5s) before SIGKILLing the shell itself.
    const { stdout, stderr } = await execa(command, {
      ...baseExecOptions(ctx.root, ctx.signal),
      shell: true,
      killDescendants: true,
      timeout: ctx.config.toolTimeout,
      maxBuffer: CHILD_MAX_BUFFER,
      stripFinalNewline: false,
    })
    // Strip only the trailing newline(s) a command's output typically ends
    // with — not a full .trim(), which would also eat meaningful leading
    // whitespace (e.g. a `git diff` context line starting with a single
    // space) or internal-to-the-last-line trailing spaces that are part of
    // the actual output.
    const combined = `${stdout}${stderr}`.replace(/\n+$/, '')
    return combined || '(no output)'
  } catch (err) {
    const e = err as ExecaError
    // Output above the buffer ceiling is discarded, so a bare maxBuffer error
    // with no captured output would be cryptic — say what happened.
    if (e.isMaxBuffer) {
      throw new Error(
        `command output exceeded ${CHILD_MAX_BUFFER} bytes; narrow the command (e.g. pipe through head or grep)`,
      )
    }
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
    // A non-zero exit carries a numeric exitCode; a timeout or an abort
    // (ctx.signal) shouldn't read as "exit <code>".
    let label: string
    if (e.isCanceled) label = 'aborted'
    else if (e.timedOut) label = 'timed out'
    else if (typeof e.exitCode === 'number') label = `exit ${e.exitCode}`
    else label = e.signal ? `killed (${e.signal})` : 'unknown'
    throw new Error(`${label}: ${out || '(no output)'}`)
  }
}

export const runShellTool = () =>
  defineTool({
    name: 'run_shell',
    parallel: false,
    description:
      'Run a shell command in the working directory with a timeout. Combined stdout/stderr is returned as the tool output.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    async execute(args, ctx) {
      return runShell(args.command, ctx)
    },
  })
