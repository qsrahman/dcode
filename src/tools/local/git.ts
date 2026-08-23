import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../../agent/types.ts'
import { resolvePath } from './paths.ts'
import { CHILD_MAX_BUFFER } from './constants.ts'

const execFileAsync = promisify(execFile)

// Only a curated, safe set of operations is exposed. Remote and destructive
// commands (push, pull, fetch, reset, checkout, clean, merge, rebase, …) are
// deliberately excluded; the model can still reach them via run_shell.
const commandEnum = z.enum([
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'branch',
])

const gitSchema = z.object({
  command: commandEnum.describe('Allowed git operation'),
  paths: z
    .array(z.string())
    .optional()
    .describe('File paths (relative to root) for add/diff'),
  message: z
    .string()
    .optional()
    .describe('Commit message (required for commit)'),
  staged: z.boolean().optional().describe('Show staged changes (diff)'),
  oneline: z.boolean().optional().describe('Compact one-line log output'),
  maxCount: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of log entries'),
  ref: z
    .string()
    .optional()
    .describe('Commit or branch reference for show/log'),
})

type GitArgs = z.infer<typeof gitSchema>

export function gitTool(): ToolDefinition<GitArgs> {
  return {
    name: 'git',
    description:
      'Run a scoped set of git operations in the working directory: status, diff, log, show, add, commit, branch. Destructive or remote operations (push, pull, reset, checkout, clean, merge, rebase) are intentionally unsupported — use run_shell for those.',
    parameters: gitSchema,
    async execute(args: GitArgs, ctx: ToolContext) {
      const gitArgs = await buildArgs(args, ctx)
      try {
        // execFile (no shell) runs the binary directly, so paths/refs can't be
        // shell-injected. timeout + signal kill the child directly (decision L);
        // the runTool deadline/abort race only rejects the promise.
        const { stdout, stderr } = await execFileAsync(
          'git',
          ['-C', ctx.root, ...gitArgs],
          {
            cwd: ctx.root,
            timeout: ctx.config.toolTimeout,
            maxBuffer: CHILD_MAX_BUFFER,
            signal: ctx.signal,
          },
        )
        return `${stdout}${stderr}`.trim() || '(no output)'
      } catch (err) {
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

async function buildArgs(args: GitArgs, ctx: ToolContext): Promise<string[]> {
  const cmd = args.command
  if (cmd === 'status') return ['status']
  if (cmd === 'branch') return ['branch', '--verbose']
  if (cmd === 'diff') {
    const a = ['diff']
    if (args.staged) a.push('--staged')
    if (args.paths?.length) a.push('--', ...(await checkPaths(args.paths, ctx)))
    return a
  }
  if (cmd === 'log') {
    const a = ['log']
    if (args.oneline) a.push('--oneline')
    if (args.maxCount) a.push('-n', String(args.maxCount))
    if (args.ref) a.push(checkRef(args.ref))
    return a
  }
  if (cmd === 'show') return args.ref ? ['show', checkRef(args.ref)] : ['show']
  if (cmd === 'add') {
    if (args.paths?.length)
      return ['add', ...(await checkPaths(args.paths, ctx))]
    return ['add', '-A']
  }
  if (!args.message) throw new Error('commit requires a message')
  return ['commit', '-m', args.message]
}

// Confine each path to root (rejects ../ escapes and symlink escapes); git -C
// root already scopes resolution, but validating up front gives a clear error.
async function checkPaths(
  paths: string[],
  ctx: ToolContext,
): Promise<string[]> {
  for (const p of paths) {
    if (p.startsWith('-')) throw new Error(`invalid path: ${p}`)
    await resolvePath(ctx.root, p)
  }
  return paths
}

function checkRef(ref: string): string {
  if (ref.startsWith('-') || /\s/.test(ref)) {
    throw new Error(`invalid ref: ${ref}`)
  }
  return ref
}
