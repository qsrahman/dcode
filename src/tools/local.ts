import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../agent/types.ts'

const execFileAsync = promisify(execFile)

// Cap grep output so a broad pattern over a large tree can't flood the model's
// context (runTool's byte-truncation is a blunt backstop, not a real limit).
const GREP_MAX_MATCHES = 200

// run_shell buffers combined stdout/stderr up to this before the child is
// killed. Comfortably above maxToolOutputBytes so normal large output is
// truncated (decision F) rather than failing the whole command.
const SHELL_MAX_BUFFER = 10 * 1024 * 1024

// Shared path confinement: every tool resolves against the session root and
// refuses to escape it (decision G). `resolvePath` is the single chokepoint.
function resolvePath(root: string, p: string): string {
  const resolved = resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes working directory: ${p}`)
  }
  return resolved
}

// Turn a Node fs error into a message the model can act on (decision H: tool
// output is untrusted, but errors should be self-correcting, not cryptic).
function fsError(err: unknown, path: string): string {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return `no such file or directory: ${path}`
    if (code === 'EISDIR') return `is a directory, use list_dir: ${path}`
    if (code === 'ENOTDIR') return `not a directory: ${path}`
    if (code === 'EACCES') return `permission denied: ${path}`
  }
  return err instanceof Error ? err.message : String(err)
}

// Shared recursive directory walk: yields every entry with its path relative to
// root. Skips symlinks (don't follow), silently continues past unreadable
// directories, and prunes ignored directory names (e.g. .git, node_modules) —
// the same traversal rules grep and glob need.
async function* walkDirs(
  root: string,
  ignore: ReadonlySet<string>,
): AsyncGenerator<{ full: string; rel: string; entry: Dirent }> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && ignore.has(entry.name)) continue
      const full = resolve(dir, entry.name)
      yield { full, rel: relative(root, full), entry }
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full)
    }
  }
}

function readFileTool(): ToolDefinition<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the working directory.',
    parameters: z.object({
      path: z.string().describe('Relative path under the working directory'),
    }),
    async execute(args: { path: string }, ctx: ToolContext) {
      const file = resolvePath(ctx.root, args.path)
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
      const dir = resolvePath(ctx.root, target)
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

function grepTool(): ToolDefinition<{ pattern: string; path?: string }> {
  return {
    name: 'grep',
    description:
      'Search file contents for a regular expression under the working directory.',
    parameters: z.object({
      pattern: z.string().describe('Regular expression to search for'),
      path: z
        .string()
        .optional()
        .describe('File or directory to search; defaults to root'),
    }),
    async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
      const target = args.path ?? '.'
      let re: RegExp
      try {
        re = new RegExp(args.pattern, 'g')
      } catch {
        throw new Error(`invalid regular expression: ${args.pattern}`)
      }
      const dir = resolvePath(ctx.root, target)
      const ignore = new Set(ctx.config.ignore)
      const matches: string[] = []
      let capped = false
      outer: for await (const { full, entry } of walkDirs(dir, ignore)) {
        if (!entry.isFile()) continue
        let content: string
        try {
          content = await readFile(full, 'utf8')
        } catch {
          continue
        }
        const rel = relative(ctx.root, full)
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          re.lastIndex = 0
          if (!re.test(line)) continue
          matches.push(`${rel}:${i + 1}: ${line}`)
          if (matches.length >= GREP_MAX_MATCHES) {
            capped = true
            break outer
          }
        }
      }
      let out = matches.join('\n') || '(no matches)'
      if (capped) {
        out += `\n… (stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or path)`
      }
      return out
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
      const full = resolvePath(ctx.root, target)
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

// Minimal glob -> RegExp: `*` matches within a path segment, `?` a single char,
// `**` matches any number of directories (including none). The project has no
// glob dependency, so this covers the patterns the agent needs.
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        re += '.*'
        if (glob[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '.') {
      re += '\\.'
    } else if ('+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(re + '$')
}

function globTool(): ToolDefinition<{ pattern: string }> {
  return {
    name: 'glob',
    description:
      'List files matching a glob pattern under the working directory. Recursive; `**` matches any number of directories.',
    parameters: z.object({
      pattern: z
        .string()
        .describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.ts"'),
    }),
    async execute(args: { pattern: string }, ctx: ToolContext) {
      const re = globToRegExp(args.pattern)
      const ignore = new Set(ctx.config.ignore)
      const matches: string[] = []
      for await (const { rel } of walkDirs(ctx.root, ignore)) {
        if (re.test(rel)) matches.push(rel)
      }
      matches.sort()
      return matches.join('\n') || '(no matches)'
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
          maxBuffer: SHELL_MAX_BUFFER,
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

// The complete local tool set. `index.ts` is the single place that registers
// these into the central ToolRegistry, so adding a tool is one line here plus
// one import there.
export const localTools: ToolDefinition[] = [
  readFileTool(),
  listDirTool(),
  grepTool(),
  statTool(),
  globTool(),
  writeFileTool(),
  editFileTool(),
  runShellTool(),
]
