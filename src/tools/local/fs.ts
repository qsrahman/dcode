import { open, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { z } from 'zod/v4'
import { defineTool } from '../registry.ts'
import { ensureParentDir, withResolvedPath } from './paths.ts'

// How much of a file read_file loads, and the largest file edit_file will
// touch. Reads use one window (not just maxToolOutputBytes) so paging with
// `offset` can reach past the first ~32 KiB of a large file; the output is
// then cut to maxToolOutputBytes at a line boundary (see pageItems). This only
// bounds the disk read.
const READ_MAX_BYTES = 8 * 1024 * 1024
// Room kept under the output cap for the footer pageItems appends: runTool
// cuts anything past the cap from the end, which would be the footer.
const NOTE_RESERVE = 128
// A single line this long is minified or generated content. Cut it so one line
// can't spend the whole output budget (claude code and opencode both do this).
const MAX_LINE_CHARS = 2000

// Show `items` from the 1-based `offset`, at most `limit` of them and at most
// maxBytes of output, always at least one. When something is left out, say
// which offset resumes — a bare "output truncated" note leaves the model
// guessing where it stopped. `last` is the 1-based index of the final item
// shown, for callers that add a footer of their own.
function pageItems(
  items: string[],
  offset: number,
  limit: number | undefined,
  maxBytes: number,
  label: string,
  format: (item: string, n: number) => string,
): { body: string; last: number } {
  const start = offset - 1
  if (start >= items.length) {
    throw new Error(
      `offset ${offset} is past the end (${items.length} ${label})`,
    )
  }
  const end = limit ? Math.min(start + limit, items.length) : items.length
  const shown: string[] = []
  let bytes = 0
  for (let i = start; i < end; i++) {
    const line = format(items[i]!, i + 1)
    bytes += Buffer.byteLength(line) + 1
    if (bytes > maxBytes - NOTE_RESERVE && shown.length > 0) break
    shown.push(line)
  }
  const last = start + shown.length
  const more =
    last < items.length
      ? `\n… (${label} ${offset}–${last} of ${items.length}; offset=${last + 1} to continue)`
      : ''
  return { body: shown.join('\n') + more, last }
}

const readFileTool = () =>
  defineTool({
    name: 'read_file',
    category: 'read',
    description:
      'Read a UTF-8 text file, or list a directory, under the working directory. File lines are prefixed with their 1-based number and a tab ("12<TAB>text"); never include that prefix when passing text to edit_file. A long result is cut with a note naming the offset to continue from. A directory is listed one entry per line, "/" marking a subdirectory and "@" a symlink.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based line (or directory entry) to start from'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum number of lines (or entries) to return'),
    }),
    async execute(args, ctx) {
      const offset = args.offset ?? 1
      const maxBytes = ctx.config.maxToolOutputBytes
      return withResolvedPath(ctx, args.path, async (file) => {
        if ((await stat(file)).isDirectory()) {
          const entries = (await readdir(file, { withFileTypes: true }))
            .map((e) =>
              e.isDirectory()
                ? `${e.name}/`
                : e.isSymbolicLink()
                  ? `${e.name}@`
                  : e.name,
            )
            .sort((a, b) => a.localeCompare(b))
          if (entries.length === 0) return '(empty directory)'
          return pageItems(
            entries,
            offset,
            args.limit,
            maxBytes,
            'entries',
            (name) => name,
          ).body
        }

        const handle = await open(file, 'r')
        try {
          // stat through the open handle, not the path again: one syscall
          // fewer, and it can't disagree with the descriptor being read.
          const { size } = await handle.stat()
          const buf = Buffer.alloc(Math.min(size, READ_MAX_BYTES))
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
          // A NUL byte means binary: dumping it as text is useless and risks
          // the model acting on mojibake, so describe it instead (as
          // web_fetch does).
          if (buf.subarray(0, bytesRead).includes(0)) {
            return `(binary ${args.path}, ${size} bytes; not shown)`
          }
          const windowed = size > bytesRead
          const lines = buf.toString('utf8', 0, bytesRead).split(/\r?\n/)
          // A final newline ends the last line rather than starting another;
          // when the window cut the file, its last line is cut mid-way too.
          if (windowed || lines.at(-1) === '') lines.pop()
          if (windowed && offset > lines.length) {
            // The offset lies past what was read, not past the file's actual
            // end — say so instead of implying the file has fewer lines.
            throw new Error(
              `offset ${offset} is beyond the ${READ_MAX_BYTES}-byte read window (file is ${size} bytes); use grep to locate the section you need`,
            )
          }
          if (lines.length === 0) return '(empty file)'
          const { body, last } = pageItems(
            lines,
            offset,
            args.limit,
            maxBytes,
            'lines',
            (ln, n) =>
              `${n}\t${ln.length > MAX_LINE_CHARS ? `${ln.slice(0, MAX_LINE_CHARS)}… (line truncated)` : ln}`,
          )
          return windowed && last === lines.length
            ? `${body}\n… (file is ${size} bytes; only the first ${READ_MAX_BYTES} are readable here)`
            : body
        } finally {
          await handle.close()
        }
      })
    },
  })

const writeFileTool = () =>
  defineTool({
    name: 'write_file',
    category: 'edit',
    parallel: false,
    description:
      'Create a UTF-8 text file under the working directory, or replace an existing one entirely. Parent directories are created. To change part of an existing file use edit_file instead.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
      content: z.string().describe('Full file contents to write'),
    }),
    async execute(args, ctx) {
      return withResolvedPath(ctx, args.path, async (file) => {
        await ensureParentDir(file, args.path)
        const existed = await stat(file)
          .then(() => true)
          .catch(() => false)
        await writeFile(file, args.content, 'utf8')
        const bytes = Buffer.byteLength(args.content)
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
      "Replace text in a file under the working directory. old_string must match the file exactly, whitespace and indentation included, and be unique unless replace_all is set — include surrounding lines to make it unique. Read the file first, and copy text without read_file's line-number prefix.",
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
      // '' matches between every character, so with replace_all it would
      // splice new_string through the whole file.
      if (args.old_string === '') {
        throw new Error('old_string must not be empty')
      }
      if (args.old_string === args.new_string) {
        throw new Error(
          'old_string and new_string are identical; nothing to change',
        )
      }
      return withResolvedPath(ctx, args.path, async (file) => {
        // Check before reading: readFile loads the whole file, so a huge one
        // would cost that much memory just to be refused as binary (and past
        // 2 GiB, Node fails with an opaque error).
        const { size } = await stat(file)
        if (size > READ_MAX_BYTES) {
          throw new Error(
            `${args.path} is too large to edit (${size} bytes; limit ${READ_MAX_BYTES}); use run_shell (sed, perl) for a file this size`,
          )
        }
        const beforeBuf = await readFile(file)
        // NUL byte ⇒ binary; editing it as text would corrupt the file, so
        // refuse rather than round-tripping mojibake through string ops.
        if (beforeBuf.includes(0)) {
          throw new Error(
            `is a binary file; edit_file only supports text: ${args.path}`,
          )
        }
        const before = beforeBuf.toString('utf8')
        // read_file shows CRLF files with plain newlines, so the model's
        // multi-line strings are LF; translate them to the file's convention
        // or they'd never match, and the edit would break its line endings.
        const crlf = before.includes('\r\n')
        const eol = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s)
        const oldStr = eol(args.old_string)
        const count = before.split(oldStr).length - 1
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
        const after = before.split(oldStr).join(eol(args.new_string))
        await writeFile(file, after, 'utf8')
        return count > 1
          ? `edited ${args.path} (${count} replacements)`
          : `edited ${args.path}`
      })
    },
  })

export { readFileTool, writeFileTool, editFileTool }
