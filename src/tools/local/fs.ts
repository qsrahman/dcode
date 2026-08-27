import { open, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { z } from 'zod'
import type { ToolDefinition } from '../../agent/types.ts'
import { resolvePath, fsError } from './paths.ts'

function readFileTool(): ToolDefinition<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
    }),
    async execute(args, ctx) {
      const file = await resolvePath(ctx.root, args.path)
      // Read at most the configured output cap so a huge or symlinked-to-huge
      // file can't blow up memory before the runner truncates the result.
      const limit = ctx.config.maxToolOutputBytes
      const handle = await open(file, 'r').catch((err) => {
        throw new Error(fsError(err, args.path))
      })
      try {
        const { size } = await stat(file)
        const buf = Buffer.alloc(Math.min(size, limit))
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        // A NUL byte means binary: dumping it as text is useless and risks the
        // model acting on mojibake, so describe it instead (as web_fetch does).
        if (buf.subarray(0, bytesRead).includes(0)) {
          return `(binary ${args.path}, ${size} bytes; not shown)`
        }
        let text = buf.toString('utf8', 0, bytesRead)
        if (size > limit)
          text += `\n…(${size} bytes total; truncated at ${limit})`
        return text
      } catch (err) {
        throw new Error(fsError(err, args.path))
      } finally {
        await handle.close()
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
    async execute(args, ctx) {
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
    async execute(args, ctx) {
      const target = args.path ?? '.'
      const full = await resolvePath(ctx.root, target)
      let info: Stats
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
    async execute(args, ctx) {
      const file = await resolvePath(ctx.root, args.path)
      try {
        await writeFile(file, args.content, 'utf8')
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
      // Byte length, not JS string length: they differ for non-ASCII content.
      return `wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`
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
    async execute(args, ctx) {
      const file = await resolvePath(ctx.root, args.path)
      const beforeBuf = await readFile(file).catch((err) => {
        throw new Error(fsError(err, args.path))
      })
      // NUL byte ⇒ binary; editing it as text would corrupt the file, so refuse
      // rather than round-tripping mojibake through string ops.
      if (beforeBuf.includes(0)) {
        throw new Error(
          `is a binary file; edit_file only supports text: ${args.path}`,
        )
      }
      const before = beforeBuf.toString('utf8')
      const count = countOccurrences(before, args.old_string)
      if (count === 0) throw new Error(`old_string not found in ${args.path}`)
      if (count > 1 && !args.replace_all) {
        throw new Error(
          `old_string matches ${count} times in ${args.path}; make it unique or pass replace_all`,
        )
      }
      // count === 1 or replace_all is guaranteed here (checked above). split/
      // join substitutes literally — replace/replaceAll would interpret
      // `$&`/`` $` ``-style patterns in new_string and silently corrupt files
      // whose content legitimately contains them (shell scripts, Makefiles).
      const after = before.split(args.old_string).join(args.new_string)
      try {
        await writeFile(file, after, 'utf8')
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
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
