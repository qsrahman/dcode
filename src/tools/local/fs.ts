import {
  open,
  readFile,
  writeFile,
  readdir,
  stat,
  lstat,
  readlink,
  mkdir,
  rename,
  copyFile,
  rm,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Stats } from 'node:fs'
import { z } from 'zod'
import type { ToolDefinition } from '../../agent/types.ts'
import { resolvePath, fsError } from './paths.ts'

// Cap directory listings so a huge directory can't flood the model's context
// (runTool's byte-truncation is a blunt backstop, not a real limit).
const LIST_MAX = 1000
// Only count lines for files up to this size; reading a multi-GB file just to
// count newlines would defeat the bounded-read discipline elsewhere.
const LINE_COUNT_MAX = 1_000_000

function readFileTool(): ToolDefinition<{
  path: string
  offset?: number
  limit?: number
  line_numbers?: boolean
}> {
  return {
    name: 'read_file',
    description:
      'Read a UTF-8 text file under the working directory. Supports paging (offset/limit in lines) and optional 1-based line numbers.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-based line to start from'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum number of lines to return'),
      line_numbers: z
        .boolean()
        .optional()
        .describe('Prefix each line with its 1-based number (default true)'),
    }),
    async execute(args, ctx) {
      const file = await resolvePath(ctx.root, args.path)
      // Read at most the configured output cap so a huge or symlinked-to-huge
      // file can't blow up memory before the runner truncates the result.
      const limitBytes = ctx.config.maxToolOutputBytes
      const handle = await open(file, 'r').catch((err) => {
        throw new Error(fsError(err, args.path))
      })
      try {
        const { size } = await stat(file)
        const buf = Buffer.alloc(Math.min(size, limitBytes))
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        // A NUL byte means binary: dumping it as text is useless and risks the
        // model acting on mojibake, so describe it instead (as web_fetch does).
        if (buf.subarray(0, bytesRead).includes(0)) {
          return `(binary ${args.path}, ${size} bytes; not shown)`
        }
        const text = buf.toString('utf8', 0, bytesRead)
        const truncated = size > limitBytes
        const lines = text.split('\n')
        const offset = args.offset ?? 0
        const window = args.limit
          ? lines.slice(offset, offset + args.limit)
          : lines.slice(offset)
        if (window.length === 0 && !truncated) return '(no lines in range)'
        const numbered = args.line_numbers ?? true
        const body = window
          .map((ln, i) => (numbered ? `${offset + i + 1}\t${ln}` : ln))
          .join('\n')
        return truncated
          ? `${body}\n…(${size} bytes total; truncated at ${limitBytes})`
          : body
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
        // Directories first, then alphabetical — predictable for the model.
        entries.sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) ||
            a.name.localeCompare(b.name),
        )
        const capped = entries.length > LIST_MAX
        const shown = capped ? entries.slice(0, LIST_MAX) : entries
        const body = shown
          .map(
            (e) =>
              `${e.isSymbolicLink() ? 'l' : e.isDirectory() ? 'd' : 'f'} ${e.name}`,
          )
          .join('\n')
        return capped
          ? `${body}\n… (showing first ${LIST_MAX} of ${entries.length}; narrow the path)`
          : body
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
      'Report type, size, modification time, and (for small text files) line count of a path under the working directory. Symlinks report their target.',
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
      const parts = [
        `type: ${info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'}`,
        `size: ${info.size} bytes`,
        `modified: ${info.mtime.toISOString()}`,
      ]
      // Report the symlink target (lstat doesn't follow the link).
      let lst: Awaited<ReturnType<typeof lstat>> | undefined
      try {
        lst = await lstat(full)
      } catch {
        // not a symlink
      }
      if (lst?.isSymbolicLink()) {
        let linkTarget = '?'
        try {
          linkTarget = await readlink(full)
        } catch {
          // leave '?'
        }
        parts.push(`target: ${linkTarget}`)
      }
      if (info.isFile() && info.size <= LINE_COUNT_MAX) {
        try {
          const content = await readFile(full, 'utf8')
          parts.push(`lines: ${content.split('\n').length}`)
        } catch {
          // ignore read errors; size/type are still reported
        }
      }
      return parts.join('\n')
    },
  }
}

function writeFileTool(): ToolDefinition<{
  path: string
  content: string
  overwrite?: boolean
  append?: boolean
}> {
  return {
    name: 'write_file',
    description:
      'Create or modify a UTF-8 text file under the working directory. Parent directories are created. Set append to add to the end; overwrite (default true) to replace an existing file, or false to refuse to clobber.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      content: z.string().describe('Full file contents to write (or append)'),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          'Replace an existing file (default true); false refuses to clobber',
        ),
      append: z
        .boolean()
        .optional()
        .describe('Append to the file instead of replacing it'),
    }),
    async execute(args, ctx) {
      const file = await resolvePath(ctx.root, args.path)
      await mkdir(dirname(file), { recursive: true }).catch((err) => {
        throw new Error(fsError(err, args.path))
      })
      const existed = await stat(file)
        .then(() => true)
        .catch(() => false)
      if (existed && !args.append && !(args.overwrite ?? true)) {
        throw new Error(
          `file already exists: ${args.path} (pass overwrite: true to replace)`,
        )
      }
      try {
        await writeFile(file, args.content, {
          encoding: 'utf8',
          flag: args.append ? 'a' : 'w',
        })
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
      const bytes = Buffer.byteLength(args.content)
      if (args.append) return `appended ${bytes} bytes to ${args.path}`
      return existed
        ? `wrote ${bytes} bytes to ${args.path} (overwrote existing)`
        : `wrote ${bytes} bytes to ${args.path}`
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

function moveFileTool(): ToolDefinition<{
  source: string
  destination: string
}> {
  return {
    name: 'move_file',
    description:
      'Move or rename a file or directory under the working directory. The destination parent directory is created if needed. Both paths must stay within the working directory.',
    parameters: z.object({
      source: z.string().describe('Existing path to move (relative to root)'),
      destination: z
        .string()
        .describe('New path for the moved item (relative to root)'),
    }),
    async execute(args, ctx) {
      const src = await resolvePath(ctx.root, args.source)
      const dst = await resolvePath(ctx.root, args.destination)
      // rename(2) won't create the destination's parent, so mirror what the
      // shell `mv` does and mkdir -p it first.
      await mkdir(dirname(dst), { recursive: true }).catch((err) => {
        throw new Error(fsError(err, args.destination))
      })
      try {
        await rename(src, dst)
      } catch (err) {
        throw new Error(fsError(err, args.destination))
      }
      return `moved ${args.source} -> ${args.destination}`
    },
  }
}

function copyFileTool(): ToolDefinition<{
  source: string
  destination: string
}> {
  return {
    name: 'copy_file',
    description:
      'Copy a file under the working directory to a new location. The destination parent directory is created if needed. Both paths must stay within the working directory.',
    parameters: z.object({
      source: z.string().describe('Existing file to copy (relative to root)'),
      destination: z.string().describe('Destination path (relative to root)'),
    }),
    async execute(args, ctx) {
      const src = await resolvePath(ctx.root, args.source)
      const dst = await resolvePath(ctx.root, args.destination)
      await mkdir(dirname(dst), { recursive: true }).catch((err) => {
        throw new Error(fsError(err, args.destination))
      })
      try {
        await copyFile(src, dst)
      } catch (err) {
        throw new Error(fsError(err, args.destination))
      }
      return `copied ${args.source} -> ${args.destination}`
    },
  }
}

function deleteFileTool(): ToolDefinition<{
  path: string
  recursive?: boolean
}> {
  return {
    name: 'delete_file',
    description:
      'Delete a file or directory under the working directory. Directories require recursive: true. Refuses to delete the working directory root itself.',
    parameters: z.object({
      path: z.string().describe('Path to delete (relative to root)'),
      recursive: z
        .boolean()
        .optional()
        .describe(
          'Delete directories recursively (required for non-empty dirs)',
        ),
    }),
    async execute(args, ctx) {
      const target = await resolvePath(ctx.root, args.path)
      // Deleting the whole working directory would wipe the user's project;
      // resolvePath allows it (it's inside root) so we must guard explicitly.
      if (target === ctx.root) {
        throw new Error('refusing to delete the working directory root')
      }
      try {
        await rm(target, { recursive: args.recursive ?? false, force: false })
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
      return `deleted ${args.path}`
    },
  }
}

function makeDirTool(): ToolDefinition<{ path: string }> {
  return {
    name: 'make_dir',
    description:
      'Create a directory under the working directory, including any missing parents.',
    parameters: z.object({
      path: z.string().describe('Directory to create (relative to root)'),
    }),
    async execute(args, ctx) {
      const dir = await resolvePath(ctx.root, args.path)
      try {
        await mkdir(dir, { recursive: true })
      } catch (err) {
        throw new Error(fsError(err, args.path))
      }
      return `created directory ${args.path}`
    },
  }
}

export {
  readFileTool,
  listDirTool,
  statTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  copyFileTool,
  deleteFileTool,
  makeDirTool,
}
