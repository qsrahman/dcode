import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolContext } from '../../agent/types.ts'
import { CHILD_MAX_BUFFER } from './constants.ts'

const execFileAsync = promisify(execFile)

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
    }
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
    throw new Error(`exit ${e.code ?? '?'}: ${out || '(no output)'}`)
  }
}
