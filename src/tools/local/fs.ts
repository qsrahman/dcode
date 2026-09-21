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
import type { Stats } from 'node:fs'
import { z } from 'zod/v4'
import { defineTool } from '../registry.ts'
import { resolvePath, ensureParentDir, withResolvedPath } from './paths.ts'

// Cap directory listings so a huge directory can't flood the model's context
// (runTool's byte-truncation is a blunt backstop, not a real limit).
const LIST_MAX = 1000
// When offset/limit is requested, read up to this much of the file instead of
// just maxToolOutputBytes — otherwise paging into a large file would only ever
// see the first ~32 KiB and silently report "no lines in range" past that,
// which reads as end-of-file when it isn't. runTool still truncates whatever
// this returns to maxToolOutputBytes, so this only bounds the disk read.
const PAGE_READ_MAX_BYTES = 8 * 1024 * 1024
// Only count lines for files up to this size; reading a multi-GB file just to
// count newlines would defeat the bounded-read discipline elsewhere.
const LINE_COUNT_MAX = 1_000_000

const readFileTool = () =>
  defineTool({
    name: 'read_file',
    category: 'read',
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
      const paging = args.offset !== undefined || args.limit !== undefined
      // Read at most the configured output cap so a huge or symlinked-to-huge
      // file can't blow up memory before the runner truncates the result.
      // Paging reads a much larger window instead — otherwise offset/limit
      // could only ever see the first ~32 KiB of a large file.
      const limitBytes = paging
        ? Math.max(PAGE_READ_MAX_BYTES, ctx.config.maxToolOutputBytes)
        : ctx.config.maxToolOutputBytes
      return withResolvedPath(ctx, args.path, async (file) => {
        const handle = await open(file, 'r')
        try {
          // stat through the open handle, not the path again: one syscall
          // fewer, and it can't disagree with the descriptor being read.
          const { size } = await handle.stat()
          const buf = Buffer.alloc(Math.min(size, limitBytes))
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
          // A NUL byte means binary: dumping it as text is useless and risks
          // the model acting on mojibake, so describe it instead (as
          // web_fetch does).
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
          if (window.length === 0) {
            // Truncated + empty window means the requested offset falls
            // beyond what was read, not beyond the file's actual end — say
            // so instead of implying the file has fewer lines than it does.
            if (truncated) {
              throw new Error(
                `offset ${offset} is beyond the ${limitBytes}-byte read window (file is ${size} bytes); narrow the offset or use grep to locate the section you need`,
              )
            }
            return '(no lines in range)'
          }
          const numbered = args.line_numbers ?? true
          const body = window
            .map((ln, i) => (numbered ? `${offset + i + 1}\t${ln}` : ln))
            .join('\n')
          return truncated
            ? `${body}\n…(${size} bytes total; truncated at ${limitBytes})`
            : body
        } finally {
          await handle.close()
        }
      })
    },
  })

const listDirTool = () =>
  defineTool({
    name: 'list_dir',
    category: 'read',
    description: 'List a directory under the working directory.',
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe('Directory under the working directory; defaults to root'),
    }),
    async execute(args, ctx) {
      const target = args.path ?? '.'
      return withResolvedPath(ctx, target, async (dir) => {
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
      })
    },
  })

const statTool = () =>
  defineTool({
    name: 'stat',
    category: 'read',
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
      return withResolvedPath(ctx, target, async (full) => {
        const info: Stats = await stat(full)
        const parts = [
          `type: ${info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'}`,
          `size: ${info.size} bytes`,
          `modified: ${info.mtime.toISOString()}`,
        ]
        // Report the symlink target (lstat doesn't follow the link). No
        // try/catch around lstat itself: the stat() above already resolved
        // this same path, and lstat resolves strictly less, so it cannot
        // fail here. readlink still can — the link may vanish between the
        // two calls — so that one keeps its own fallback.
        const lst = await lstat(full)
        if (lst.isSymbolicLink()) {
          const linkTarget = await readlink(full).catch(() => '?')
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
      })
    },
  })

const writeFileTool = () =>
  defineTool({
    name: 'write_file',
    category: 'edit',
    parallel: false,
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
      return withResolvedPath(ctx, args.path, async (file) => {
        await ensureParentDir(file, args.path)
        const existed = await stat(file)
          .then(() => true)
          .catch(() => false)
        if (existed && !args.append && !(args.overwrite ?? true)) {
          throw new Error(
            `file already exists: ${args.path} (pass overwrite: true to replace)`,
          )
        }
        await writeFile(file, args.content, {
          encoding: 'utf8',
          flag: args.append ? 'a' : 'w',
        })
        const bytes = Buffer.byteLength(args.content)
        if (args.append) return `appended ${bytes} bytes to ${args.path}`
        return existed
          ? `wrote ${bytes} bytes to ${args.path} (overwrote existing)`
          : `wrote ${bytes} bytes to ${args.path}`
      })
    },
  })

// Edit by string replacement. Requiring a unique match (unless replace_all) is
// deliberate: it forces the model to pin the edit to an unambiguous anchor
// rather than silently clobbering every occurrence (decision K).
const editFileTool = () =>
  defineTool({
    name: 'edit_file',
    category: 'edit',
    parallel: false,
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
      return withResolvedPath(ctx, args.path, async (file) => {
        const beforeBuf = await readFile(file)
        // NUL byte ⇒ binary; editing it as text would corrupt the file, so
        // refuse rather than round-tripping mojibake through string ops.
        if (beforeBuf.includes(0)) {
          throw new Error(
            `is a binary file; edit_file only supports text: ${args.path}`,
          )
        }
        const before = beforeBuf.toString('utf8')
        const count = before.split(args.old_string).length - 1
        if (count === 0) {
          throw new Error(`old_string not found in ${args.path}`)
        }
        if (count > 1 && !args.replace_all) {
          throw new Error(
            `old_string matches ${count} times in ${args.path}; make it unique or pass replace_all`,
          )
        }
        // count === 1 or replace_all is guaranteed here (checked above).
        // split/join substitutes literally — replace/replaceAll would
        // interpret `$&`/`` $` ``-style patterns in new_string and silently
        // corrupt files whose content legitimately contains them (shell
        // scripts, Makefiles).
        const after = before.split(args.old_string).join(args.new_string)
        await writeFile(file, after, 'utf8')
        return `edited ${args.path}`
      })
    },
  })

const moveFileTool = () =>
  defineTool({
    name: 'move_file',
    category: 'edit',
    parallel: false,
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
      return withResolvedPath(ctx, args.destination, async (dst) => {
        // rename(2) won't create the destination's parent, so mirror what
        // the shell `mv` does and mkdir -p it first.
        await ensureParentDir(dst, args.destination)
        await rename(src, dst)
        return `moved ${args.source} -> ${args.destination}`
      })
    },
  })

const copyFileTool = () =>
  defineTool({
    name: 'copy_file',
    category: 'edit',
    parallel: false,
    description:
      'Copy a file under the working directory to a new location. The destination parent directory is created if needed. Both paths must stay within the working directory.',
    parameters: z.object({
      source: z.string().describe('Existing file to copy (relative to root)'),
      destination: z.string().describe('Destination path (relative to root)'),
    }),
    async execute(args, ctx) {
      const src = await resolvePath(ctx.root, args.source)
      return withResolvedPath(ctx, args.destination, async (dst) => {
        await ensureParentDir(dst, args.destination)
        await copyFile(src, dst)
        return `copied ${args.source} -> ${args.destination}`
      })
    },
  })

const deleteFileTool = () =>
  defineTool({
    name: 'delete_file',
    category: 'edit',
    parallel: false,
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
      return withResolvedPath(ctx, args.path, async (target) => {
        // Deleting the whole working directory would wipe the user's
        // project; resolvePath allows it (it's inside root) so we must
        // guard explicitly.
        if (target === ctx.root) {
          throw new Error('refusing to delete the working directory root')
        }
        await rm(target, { recursive: args.recursive ?? false, force: false })
        return `deleted ${args.path}`
      })
    },
  })

const makeDirTool = () =>
  defineTool({
    name: 'make_dir',
    category: 'edit',
    parallel: false,
    description:
      'Create a directory under the working directory, including any missing parents.',
    parameters: z.object({
      path: z.string().describe('Directory to create (relative to root)'),
    }),
    async execute(args, ctx) {
      return withResolvedPath(ctx, args.path, async (dir) => {
        await mkdir(dir, { recursive: true })
        return `created directory ${args.path}`
      })
    },
  })

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
