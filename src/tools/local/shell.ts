import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { CHILD_MAX_BUFFER } from './constants.ts'

const execFileAsync = promisify(execFile)

function runShellTool(): ToolDefinition<{ command: string }> {
  return {
    name: 'run_shell',
    description:
      'Run a shell command in the working directory with a timeout. Combined stdout/stderr is returned as the tool output.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    async execute(args: { command: string }, ctx: ToolContext) {
      try {
        // `timeout` and `signal` both kill the child directly: the runTool
        // deadline/abort race only rejects the promise, which would otherwise
        // leave the process running and holding the event loop open.
        const { stdout, stderr } = await execFileAsync(args.command, [], {
          cwd: ctx.root,
          shell: true,
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
    },
  }
}

export { runShellTool }
