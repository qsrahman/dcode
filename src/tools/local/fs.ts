import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { resolvePath, fsError } from './paths.ts'

function readFileTool(): ToolDefinition<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
    }),
    async execute(args: { path: string }, ctx: ToolContext) {
      const file = await resolvePath(ctx.root, args.path)
      try {
        return await readFile(file, 'utf8')
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
    },
  }
}

function listDirTool(): ToolDefinition<{ path?: string }> {
  return {
    name: 'list_dir',
    description: 'List a directory under the working directory.',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Directory under the working directory; defaults to root'),
    }),
    async execute(args: { path?: string }, ctx: ToolContext) {
      const target = args.path ?? '.'
      const dir = await resolvePath(ctx.root, target)
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
          .join('\n')
      } catch (err) {
        throw new Error(fsError(err, target))
      }
    },
  }
}

function statTool(): ToolDefinition<{ path?: string }> {
  return {
    name: 'stat',
    description:
      'Report type, size, and modification time of a file or directory under the working directory.',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Path under the working directory; defaults to root'),
    }),
    async execute(args: { path?: string }, ctx: ToolContext) {
      const target = args.path ?? '.'
      const full = await resolvePath(ctx.root, target)
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(full)
      } catch (err) {
        throw new Error(fsError(err, target))
      }
      const kind = info.isDirectory()
        ? 'directory'
        : info.isFile()
          ? 'file'
          : 'other'
      return [
        `type: ${kind}`,
        `size: ${info.size} bytes`,
        `modified: ${info.mtime.toISOString()}`,
      ].join('\n')
    },
  }
}

function writeFileTool(): ToolDefinition<{ path: string; content: string }> {
  return {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      content: z.string().describe('Full file contents to write'),
    }),
    async execute(args: { path: string; content: string }, ctx: ToolContext) {
      const file = await resolvePath(ctx.root, args.path)
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
      const file = await resolvePath(ctx.root, args.path)
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

export { readFileTool, listDirTool, statTool, writeFileTool, editFileTool }
