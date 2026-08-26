import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { runExec } from './exec.ts'

function runShellTool(): ToolDefinition<{ command: string }> {
  return {
    name: 'run_shell',
    description:
      'Run a shell command in the working directory with a timeout. Combined stdout/stderr is returned as the tool output.',
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    async execute(args: { command: string }, ctx: ToolContext) {
      return runExec(args.command, [], ctx, { shell: true })
    },
  }
}

export { runShellTool }
