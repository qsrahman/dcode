import { execa } from 'execa'
import type { ExecaError } from 'execa'
import { z } from 'zod/v4'
import type { ToolContext } from '../../agent/types.ts'
import { defineTool } from '../registry.ts'

// Shared child_process buffer ceiling, derived from maxToolOutputBytes rather
// than a fixed constant: its only job is to stay comfortably above whatever
// maxToolOutputBytes is set to, so a large command's output gets dcode's own
// clean truncation-with-note (runTool's truncate()) instead of execa silently
// killing the child and discarding everything the moment maxToolOutputBytes
// is raised past a fixed ceiling. Deriving it (rather than adding a second,
// independently-configured setting) means that invariant can't drift out of
// sync the way two hand-kept-in-relationship numbers could. The 10 MiB floor
// keeps today's behavior unchanged at the default (32 KiB); the 4x multiplier
// preserves the same "comfortably above" margin if maxToolOutputBytes is
// raised past ~2.5 MiB.
export function childMaxBuffer(maxToolOutputBytes: number): number {
  return Math.max(10 * 1024 * 1024, maxToolOutputBytes * 4)
}

// Don't let child processes inherit secret-looking environment variables
// (API keys, tokens): `run_shell` could otherwise `printenv` them straight
// into tool output and the model context. Keep ordinary runtime vars (PATH,
// HOME, LANG, …) so commands still work. Exported for tools/mcp/manager.ts,
// which spawns stdio MCP servers as its own trusted child processes and
// wants the same ambient-secret stripping as every other spawn in
// tools/local/ (an MCP server's own explicitly configured env is layered on
// top of this, not filtered by it — see manager.ts).
const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE/i
export function safeEnv(): Record<string, string> {
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
async function runShell(
  command: string,
  ctx: ToolContext,
  timeout?: number,
): Promise<string> {
  const maxBuffer = childMaxBuffer(ctx.config.maxToolOutputBytes)
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
      // No terminal is attached to a tool call. With the default open pipe, a
      // command that reads stdin (`cat`, a bare `git commit`, an installer's
      // prompt) would sit there until the timeout; /dev/null makes it see EOF
      // and fail fast instead.
      stdin: 'ignore',
      // Capped by ctx.config.toolTimeout: the runTool deadline races
      // every tool against that value, so letting this exceed it would kill
      // the loop's timeout first and orphan the child until its own (longer)
      // timeout fires.
      timeout: Math.min(
        timeout ?? ctx.config.toolTimeout,
        ctx.config.toolTimeout,
      ),
      maxBuffer,
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
        `command output exceeded ${maxBuffer} bytes; narrow the command (e.g. pipe through head or grep)`,
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
    category: 'run',
    parallel: false,
    // A failing build or test prints its verdict last, so an oversized result
    // keeps its end as well as its start.
    keep: 'ends',
    description:
      'Run a shell command in the working directory and return its combined stdout/stderr; a non-zero exit is reported as an error. The command has no stdin (it sees EOF) and is killed at the timeout, so start servers, watchers, and anything long-running with run_process instead. Output over the size cap keeps its start and end. Changes take effect immediately, so check before repeating a command that may already have run. Use it for file operations such as mv, cp, rm, mkdir, and for git.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
      timeout: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Timeout for this command in ms; the default and the maximum are the session tool timeout (120000 unless configured)',
        ),
    }),
    async execute(args, ctx) {
      return runShell(args.command, ctx, args.timeout)
    },
  })
