import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolContext, ToolDefinition } from '../../agent/types.ts'
import { resolvePath } from './fs.ts'

const execFileAsync = promisify(execFile)

export function createMutateTools(): ToolDefinition[] {
  return [writeFileTool(), editFileTool(), runShellTool()]
}

function writeFileTool(): ToolDefinition<{ path: string; content: string }> {
  return {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file under the working directory.',
    mutates: true,
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      content: z.string().describe('Full file contents to write'),
    }),
    async execute(args: { path: string; content: string }, ctx: ToolContext) {
      const file = resolvePath(ctx.root, args.path)
      await writeFile(file, args.content, 'utf8')
      return `wrote ${args.content.length} bytes to ${args.path}`
    },
  }
}

// Edit by string replacement. Requiring a unique match (unless replace_all) is
// deliberate: it forces the model to pin the edit to an unambiguous anchor
// rather than silently clobbering every occurrence (decision K).
function editFileTool(): ToolDefinition<{
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}> {
  return {
    name: 'edit_file',
    description:
      'Replace occurrences of a string in a file under the working directory. Requires an exact, unique match unless replace_all is set.',
    mutates: true,
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      old_string: z.string().describe('Text to replace'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z
        .boolean()
        .optional()
        .describe('Replace all occurrences instead of requiring exactly one'),
    }),
    async execute(
      args: {
        path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      },
      ctx: ToolContext,
    ) {
      const file = resolvePath(ctx.root, args.path)
      const before = await readFile(file, 'utf8')
      const count = countOccurrences(before, args.old_string)
      if (count === 0) throw new Error(`old_string not found in ${args.path}`)
      if (count > 1 && !args.replace_all) {
        throw new Error(
          `old_string matches ${count} times in ${args.path}; make it unique or pass replace_all`,
        )
      }
      const after = args.replace_all
        ? before.split(args.old_string).join(args.new_string)
        : before.replace(args.old_string, args.new_string)
      await writeFile(file, after, 'utf8')
      return `edited ${args.path}`
    },
  }
}

function runShellTool(): ToolDefinition<{ command: string }> {
  return {
    name: 'run_shell',
    description:
      'Run a shell command in the working directory with a timeout. Combined stdout/stderr is returned as the tool output.',
    mutates: true,
    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    async execute(args: { command: string }, ctx: ToolContext) {
      const { stdout, stderr } = await execFileAsync(args.command, [], {
        cwd: ctx.root,
        shell: true,
        timeout: ctx.config.toolTimeout,
        maxBuffer: ctx.config.maxToolOutputBytes,
      })
      const out = `${stdout}${stderr}`.trim()
      return out || '(no output)'
    },
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}
