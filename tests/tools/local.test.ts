import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  access,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readFileTool,
  writeFileTool,
  editFileTool,
} from '../../src/tools/local/fs.ts'
import { grepTool, globTool } from '../../src/tools/local/search.ts'
import { runShellTool, childMaxBuffer } from '../../src/tools/local/exec.ts'
import {
  runProcessTool,
  readProcessTool,
  killProcessTool,
  processManager,
} from '../../src/tools/local/process.ts'
import type { ToolDefinition } from '../../src/agent/types.ts'
import { runTool } from '../../src/agent/exec.ts'
import type { ToolCall, ToolContext } from '../../src/agent/types.ts'
import { z } from 'zod/v4'
import { defineTool } from '../../src/tools/registry.ts'
import { getEventListeners } from 'node:events'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

let root: string
let ctx: ToolContext

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-tools-'))
  ctx = { root, config: cfg(), logger: createLogger(cfg()) }
})
afterEach(async () => {
  processManager.killAll()
  await rm(root, { recursive: true, force: true })
})

const localTools: ToolDefinition[] = [
  readFileTool(),
  grepTool(),
  globTool(),
  writeFileTool(),
  editFileTool(),
  runShellTool(),
  runProcessTool(),
  readProcessTool(),
  killProcessTool(),
]

function tool(name: string) {
  const t = localTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

describe('childMaxBuffer', () => {
  it('keeps the 10 MiB floor at the default maxToolOutputBytes', () => {
    expect(childMaxBuffer(32768)).toBe(10 * 1024 * 1024)
  })

  it('scales past the floor once maxToolOutputBytes exceeds ~2.5 MiB', () => {
    const big = 4 * 1024 * 1024
    expect(childMaxBuffer(big)).toBe(big * 4)
    expect(childMaxBuffer(big)).toBeGreaterThan(10 * 1024 * 1024)
  })
})

describe('read-only tools', () => {
  it('read_file returns file contents and rejects escapes', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    const out = await tool('read_file').execute({ path: 'a.txt' }, ctx)
    expect(out).toBe('1\thello')
    await expect(
      tool('read_file').execute({ path: '../evil' }, ctx),
    ).rejects.toThrow(/escapes/)
  })

  it('read_file supports offset/limit paging', async () => {
    await writeFile(join(root, 'n.txt'), 'a\nb\nc\nd\ne')
    const out = await tool('read_file').execute(
      { path: 'n.txt', offset: 1, limit: 2 },
      ctx,
    )
    expect(out).toBe('1\ta\n2\tb\n… (lines 1–2 of 5; offset=3 to continue)')
  })

  it('read_file paging past the read window errors instead of implying EOF', async () => {
    // No newlines, so the whole file is one "line" within the 8 MiB paging
    // window; offset 2 asks for a line past what was read, not past the
    // file's actual end.
    await writeFile(join(root, 'big.txt'), 'x'.repeat(9 * 1024 * 1024))
    await expect(
      tool('read_file').execute({ path: 'big.txt', offset: 2 }, ctx),
    ).rejects.toThrow(/beyond the \d+-byte read window/)
  })

  it('grep finds matching lines', async () => {
    await writeFile(join(root, 'a.txt'), 'foo bar\nbaz\n')
    const out = await tool('grep').execute({ pattern: 'bar' }, ctx)
    expect(out).toContain('a.txt:1: foo bar')
  })

  it('grep filters by file glob', async () => {
    await writeFile(join(root, 'a.ts'), 'needle')
    await writeFile(join(root, 'b.js'), 'needle')
    const out = await tool('grep').execute(
      { pattern: 'needle', include: '*.ts' },
      ctx,
    )
    expect(out).toContain('a.ts')
    expect(out).not.toContain('b.js')
  })

  // Binary files decoded as UTF-8 yield garbage lines; a NUL byte in the
  // leading chunk (git's heuristic) marks them as binary and they're skipped.
  it('grep skips binary files', async () => {
    await writeFile(
      join(root, 'img.bin'),
      Buffer.from('\x89PNG\r\n\x00\x00needle\x00', 'binary'),
    )
    await writeFile(join(root, 'text.txt'), 'needle')
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out).toContain('text.txt')
    expect(out).not.toContain('img.bin')
  })

  it('grep and glob prune ignored directories (node_modules, .git)', async () => {
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'dep.ts'), 'needle')
    await writeFile(join(root, 'app.ts'), 'needle')
    const g = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(g).toContain('app.ts')
    expect(g).not.toContain('node_modules')
    const gl = await tool('glob').execute({ pattern: '**/*.ts' }, ctx)
    expect(gl).toContain('app.ts')
    expect(gl).not.toContain('node_modules')
  })

  it('grep and glob honor gitignore-syntax patterns, not just bare names', async () => {
    await writeFile(join(root, 'app.ts'), 'needle')
    await writeFile(join(root, 'debug.log'), 'needle')
    const globCtx = { ...ctx, config: cfg({ ignore: ['*.log'] }) }
    const g = await tool('grep').execute({ pattern: 'needle' }, globCtx)
    expect(g).toContain('app.ts')
    expect(g).not.toContain('debug.log')
    const gl = await tool('glob').execute({ pattern: '**/*' }, globCtx)
    expect(gl).toContain('app.ts')
    expect(gl).not.toContain('debug.log')
  })

  it('grep skips files above the size guard (ripgrep --max-filesize)', async () => {
    await writeFile(join(root, 'big.txt'), 'needle\n'.repeat(800_000))
    await writeFile(join(root, 'small.txt'), 'needle')
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out).toContain('small.txt')
    expect(out).not.toContain('big.txt')
    // Silent skips read as "nothing there"; the model has to be told.
    expect(out).toMatch(/skipped 1 file over 5 MiB/)
  })

  it('grep says so when the only candidate was skipped for size', async () => {
    await writeFile(join(root, 'big.txt'), 'needle\n'.repeat(800_000))
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out).toBe('(no matches; skipped 1 file over 5 MiB)')
  })

  it('grep says nothing about skipping when no file was skipped', async () => {
    await writeFile(join(root, 'a.txt'), 'needle')
    expect(await tool('grep').execute({ pattern: 'needle' }, ctx)).toBe(
      'a.txt:1: needle',
    )
    expect(await tool('grep').execute({ pattern: 'nope' }, ctx)).toBe(
      '(no matches)',
    )
  })

  it('grep counts skipped files within the requested scope only', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'big.txt'), 'needle\n'.repeat(800_000))
    await writeFile(join(root, 'a.txt'), 'needle')
    const out = await tool('grep').execute(
      { pattern: 'needle', include: 'a.txt' },
      ctx,
    )
    expect(out).toBe('a.txt:1: needle')
  })

  // The JS implementation used to cap line length against catastrophic
  // backtracking (regex execution was synchronous and could hang the whole
  // process). ripgrep's regex engine is guaranteed linear-time, so that
  // protection is now structural rather than a length cutoff — this searches
  // a genuinely long line and expects it to just work.
  it('grep searches a very long line without hanging', async () => {
    await writeFile(join(root, 'a.txt'), 'x'.repeat(50_000) + 'needle')
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out).toContain('a.txt:1:')
  })

  it('grep caps total matches with a note', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `m${i}`).join('\n')
    await writeFile(join(root, 'big.txt'), lines)
    const out = await tool('grep').execute({ pattern: 'm' }, ctx)
    const hits = out.split('\n').filter((l) => l.startsWith('big.txt'))
    expect(hits.length).toBe(200)
    expect(out).toMatch(/stopped at 200 matches/)
  })

  it('glob matches recursively with **', async () => {
    await writeFile(join(root, 'a.ts'), 'x')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'b.ts'), 'x')
    await writeFile(join(root, 'sub', 'c.js'), 'x')
    const out = await tool('glob').execute({ pattern: '**/*.ts' }, ctx)
    expect(out).toContain('a.ts')
    expect(out).toContain('sub/b.ts')
    expect(out).not.toContain('sub/c.js')
  })

  it('glob scopes to a directory prefix', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'b.ts'), 'x')
    const out = await tool('glob').execute({ pattern: 'sub/**' }, ctx)
    expect(out).toContain('sub/b.ts')
  })

  it('glob returns (no matches) when nothing matches', async () => {
    const out = await tool('glob').execute({ pattern: '**/*.zzz' }, ctx)
    expect(out).toBe('(no matches)')
  })

  it('glob caps results and reports a footer', async () => {
    for (let i = 0; i < 50; i++) {
      await writeFile(join(root, `f${i}.txt`), 'x')
    }
    const out = await tool('glob').execute(
      { pattern: '**/*.txt', limit: 10 },
      ctx,
    )
    expect(out).toMatch(/showing first 10 of 50/)
  })

  it('glob accepts brace alternatives', async () => {
    await writeFile(join(root, 'a.ts'), 'x')
    await writeFile(join(root, 'b.js'), 'x')
    await writeFile(join(root, 'c.md'), 'x')
    const out = await tool('glob').execute({ pattern: '**/*.{ts,js}' }, ctx)
    expect(out).toContain('a.ts')
    expect(out).toContain('b.js')
    expect(out).not.toContain('c.md')
  })

  it('read_file reports a missing file clearly', async () => {
    await expect(
      tool('read_file').execute({ path: 'nope.txt' }, ctx),
    ).rejects.toThrow(/no such file or directory/)
  })

  it('read_file describes binary files instead of dumping them', async () => {
    await writeFile(
      join(root, 'img.bin'),
      Buffer.from('\x89PNG\r\n\x00\x00body\x00', 'binary'),
    )
    const out = await tool('read_file').execute({ path: 'img.bin' }, ctx)
    expect(out).toContain('(binary img.bin')
    expect(out).toContain('bytes; not shown)')
    expect(out).not.toContain('body')
  })

  it('grep reports an invalid regular expression clearly', async () => {
    await expect(tool('grep').execute({ pattern: '(' }, ctx)).rejects.toThrow(
      /invalid regular expression/,
    )
  })

  it('grep supports case-insensitive search', async () => {
    await writeFile(join(root, 'a.txt'), 'Foo BAR')
    const out = await tool('grep').execute(
      { pattern: 'foo', ignore_case: true },
      ctx,
    )
    expect(out).toContain('a.txt:1: Foo BAR')
  })

  it('grep shows context lines around matches', async () => {
    await writeFile(join(root, 'a.txt'), 'x\nMATCH\ny')
    const out = await tool('grep').execute(
      { pattern: 'MATCH', context: 1 },
      ctx,
    )
    // Context lines use `-` (ripgrep's own convention); only the actual
    // match line uses `:`.
    expect(out).toContain('a.txt-1- x')
    expect(out).toContain('a.txt:2: MATCH')
    expect(out).toContain('a.txt-3- y')
  })
})

describe('mutating tools', () => {
  it('write_file writes content', async () => {
    const out = await tool('write_file').execute(
      { path: 'a.txt', content: 'hello' },
      ctx,
    )
    expect(out).toContain('wrote')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('edit_file replaces a unique occurrence', async () => {
    await writeFile(join(root, 'a.txt'), 'foo bar baz')
    const out = await tool('edit_file').execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'baz' },
      ctx,
    )
    expect(out).toContain('edited')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('baz bar baz')
  })

  it('edit_file errors when old_string is absent', async () => {
    await writeFile(join(root, 'a.txt'), 'foo')
    await expect(
      tool('edit_file').execute(
        { path: 'a.txt', old_string: 'nope', new_string: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/not found/)
  })

  it('edit_file errors when old_string is ambiguous without replace_all', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo')
    await expect(
      tool('edit_file').execute(
        { path: 'a.txt', old_string: 'foo', new_string: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/matches/)
  })

  it('edit_file replace_all replaces every occurrence', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo')
    await tool('edit_file').execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'x', replace_all: true },
      ctx,
    )
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('x x')
  })

  it('edit_file refuses binary files', async () => {
    await writeFile(
      join(root, 'img.bin'),
      Buffer.from('\x00\x01\x02', 'binary'),
    )
    await expect(
      tool('edit_file').execute(
        { path: 'img.bin', old_string: 'x', new_string: 'y' },
        ctx,
      ),
    ).rejects.toThrow(/is a binary file/)
  })

  it('write_file reports write errors clearly', async () => {
    await mkdir(join(root, 'sub'))
    await expect(
      tool('write_file').execute({ path: 'sub', content: 'x' }, ctx),
    ).rejects.toThrow(/is a directory/)
  })

  it('write_file replaces an existing file and says so', async () => {
    await writeFile(join(root, 'a.txt'), 'old')
    const out = await tool('write_file').execute(
      { path: 'a.txt', content: 'new' },
      ctx,
    )
    expect(out).toContain('overwrote existing')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  it('write_file creates parent directories', async () => {
    const out = await tool('write_file').execute(
      { path: 'sub/deep/f.txt', content: 'x' },
      ctx,
    )
    expect(out).toContain('wrote')
    expect(await readFile(join(root, 'sub/deep/f.txt'), 'utf8')).toBe('x')
  })

  // String.replace would interpret `$&`-style patterns in new_string; the edit
  // must be literal (e.g. shell/Makefile content containing `$@` or `$&`).
  it('edit_file substitutes new_string literally, never as a $ pattern', async () => {
    await writeFile(join(root, 'a.txt'), 'echo TARGET')
    await tool('edit_file').execute(
      { path: 'a.txt', old_string: 'TARGET', new_string: '$& $$ $`' },
      ctx,
    )
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('echo $& $$ $`')
  })

  it('run_shell captures combined output', async () => {
    const out = await tool('run_shell').execute({ command: 'echo hi' }, ctx)
    expect(out).toContain('hi')
  })

  it('run_shell does not leak secret environment variables', async () => {
    process.env.DCODE_TEST_SECRET = 'tops3cret'
    try {
      const out = await tool('run_shell').execute(
        { command: 'echo "$DCODE_TEST_SECRET"' },
        ctx,
      )
      expect(out).not.toContain('tops3cret')
    } finally {
      delete process.env.DCODE_TEST_SECRET
    }
  })

  it('run_shell reports a clear error when output exceeds the buffer', async () => {
    await expect(
      tool('run_shell').execute({ command: 'head -c 11000000 /dev/zero' }, ctx),
    ).rejects.toThrow(/exceeded/)
  })

  // childMaxBuffer's only job is staying comfortably above whatever
  // maxToolOutputBytes is configured to, not a fixed 10 MiB regardless of
  // it — this is the scaling that command output exceeded ... bytes above
  // relies on being accurate.
  it('run_shell raises its buffer ceiling when maxToolOutputBytes is raised', async () => {
    // 4 MiB -> childMaxBuffer's 4x multiplier gives a 16 MiB ceiling, so an
    // 11 MB write that fails at the default (10 MiB floor) succeeds here.
    const big = { ...ctx, config: cfg({ maxToolOutputBytes: 4 * 1024 * 1024 }) }
    const out = await tool('run_shell').execute(
      { command: 'head -c 11000000 /dev/zero | tr "\\0" "a"' },
      big,
    )
    expect(out.length).toBeGreaterThan(10 * 1024 * 1024)
  })

  it('run_shell labels timeouts by code rather than exit', async () => {
    const fast = { ...ctx, config: cfg({ toolTimeout: 150 }) }
    await expect(
      tool('run_shell').execute({ command: 'sleep 0.7' }, fast),
    ).rejects.toThrow(/timed out|aborted|ABORT_ERR|ETIMEDOUT/)
  })

  it('run_shell honors a per-command timeout', async () => {
    const t0 = Date.now()
    await expect(
      tool('run_shell').execute({ command: 'sleep 1', timeout: 100 }, ctx),
    ).rejects.toThrow(/timed out|ABORT_ERR|ETIMEDOUT/)
    expect(Date.now() - t0).toBeLessThan(800)
  })

  it('run_shell caps a timeout above the session tool timeout', async () => {
    const fast = { ...ctx, config: cfg({ toolTimeout: 150 }) }
    const t0 = Date.now()
    // timeout 5000 exceeds fast's 150ms session cap; the loop deadline must
    // still be what fires, or the child would outlive the runTool race.
    await expect(
      tool('run_shell').execute({ command: 'sleep 0.7', timeout: 5000 }, fast),
    ).rejects.toThrow(/timed out|aborted|ABORT_ERR|ETIMEDOUT/)
    expect(Date.now() - t0).toBeLessThan(800)
  })

  it('run_shell preserves stdout and stderr when the command fails', async () => {
    await expect(
      tool('run_shell').execute(
        { command: 'echo out; echo err 1>&2; exit 3' },
        ctx,
      ),
    ).rejects.toThrow(/exit 3: out\nerr/)
  })

  it('run_shell kills the child on timeout instead of orphaning it', async () => {
    const fast = { ...ctx, config: cfg({ toolTimeout: 150 }) }
    await expect(
      tool('run_shell').execute(
        { command: 'sleep 0.7; touch marker.txt' },
        fast,
      ),
    ).rejects.toThrow()
    // A live (orphaned) child would create marker.txt ~0.7s in; wait past that
    // and confirm it never appears — proving the child was actually SIGTERM'd.
    await new Promise((r) => setTimeout(r, 900))
    await expect(access(join(root, 'marker.txt'))).rejects.toThrow()
  })

  it('run_shell aborts promptly when ctx.signal fires', async () => {
    const ac = new AbortController()
    const abortCtx = {
      ...ctx,
      signal: ac.signal,
      config: cfg({ toolTimeout: 60_000 }),
    }
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    await expect(
      tool('run_shell').execute(
        { command: 'sleep 5; touch nope.txt' },
        abortCtx,
      ),
    ).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(2000)
    // The child was killed before its sleep completed, so no file was written.
    await new Promise((r) => setTimeout(r, 200))
    await expect(access(join(root, 'nope.txt'))).rejects.toThrow()
  })

  it('rejects paths that escape the working directory', async () => {
    await expect(
      tool('write_file').execute({ path: '../escape.txt', content: 'x' }, ctx),
    ).rejects.toThrow(/escapes/)
  })
})

describe('symlink confinement', () => {
  let outside: string
  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'dcode-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
  })
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true })
  })

  it('rejects reading through a symlinked dir that points outside root', async () => {
    await symlink(outside, join(root, 'link'))
    await expect(
      tool('read_file').execute({ path: 'link/secret.txt' }, ctx),
    ).rejects.toThrow(/escapes/)
  })

  it('rejects writing through a symlinked dir that points outside root', async () => {
    await symlink(outside, join(root, 'link'))
    await expect(
      tool('write_file').execute({ path: 'link/evil.txt', content: 'x' }, ctx),
    ).rejects.toThrow(/escapes/)
    await expect(access(join(outside, 'evil.txt'))).rejects.toThrow()
  })

  it('rejects reading a leaf symlink whose target is outside root', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    await expect(
      tool('read_file').execute({ path: 'leak.txt' }, ctx),
    ).rejects.toThrow(/escapes/)
  })

  it('grep and glob do not follow symlinks out of root', async () => {
    await symlink(outside, join(root, 'link'))
    await writeFile(join(root, 'in.txt'), 'TOP SECRET')
    const g = await tool('grep').execute({ pattern: 'TOP SECRET' }, ctx)
    expect(g).toContain('in.txt')
    expect(g).not.toContain('secret.txt')
    const gl = await tool('glob').execute({ pattern: '**/*' }, ctx)
    expect(gl).toContain('in.txt')
    expect(gl).not.toContain('link')
  })

  it('still resolves a symlink that stays inside root', async () => {
    await writeFile(join(root, 'real.txt'), 'inside')
    await symlink(join(root, 'real.txt'), join(root, 'alias.txt'))
    expect(await tool('read_file').execute({ path: 'alias.txt' }, ctx)).toBe(
      '1\tinside',
    )
  })
})

describe('runTool', () => {
  it('validates args and returns a clear error on failure', async () => {
    const call: ToolCall = { id: 'c', name: 'read_file', arguments: '{}' }
    const res = await runTool(call, tool('read_file'), ctx)
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/error/)
    expect(res.output).toMatch(/path/i)
  })

  it('runs successfully on valid args', async () => {
    await writeFile(join(root, 'a.txt'), 'hi')
    const call: ToolCall = {
      id: 'c',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    }
    const res = await runTool(call, tool('read_file'), ctx)
    expect(res.ok).toBe(true)
    expect(res.output).toBe('1\thi')
  })

  // withDeadline has to actually race the tool promise, not just await it and
  // check the signals afterwards: a tool that never settles and never observes
  // ctx.signal (a prompt waiting on stdin, a stalled socket) would otherwise
  // hold the agent loop open forever with toolTimeout never enforced.
  const neverSettles: ToolDefinition<Record<string, never>> = {
    name: 'never_settles',
    description: 'hangs forever',
    parameters: z.object({}),
    execute: () => new Promise<string>(() => {}),
  }
  const hangCall: ToolCall = {
    id: 'c',
    name: 'never_settles',
    arguments: '{}',
  }

  it('times out a tool that never settles', async () => {
    const res = await runTool(hangCall, neverSettles as ToolDefinition, {
      ...ctx,
      config: cfg({ toolTimeout: 20 }),
    })
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/timed out after 20ms/)
  })

  it('aborts a tool that never settles when ctx.signal fires', async () => {
    const ac = new AbortController()
    const pending = runTool(hangCall, neverSettles as ToolDefinition, {
      ...ctx,
      signal: ac.signal,
    })
    ac.abort()
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/aborted/)
  })

  it('does not leave an abort listener on a caller signal after a fast tool', async () => {
    await writeFile(join(root, 'a.txt'), 'hi')
    const ac = new AbortController()
    const call: ToolCall = {
      id: 'c',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    }
    for (let i = 0; i < 5; i++) {
      await runTool(call, tool('read_file'), { ...ctx, signal: ac.signal })
    }
    // AbortSignal is an EventTarget; Node exposes the count for assertions.
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  })
})

describe('background process tools', () => {
  it('run_process starts and read_process shows output + exit status', async () => {
    const out = await tool('run_process').execute(
      { command: 'node -e "console.log(\'hello\')"' },
      ctx,
    )
    const handle = out.match(/started (proc-\d+)/)?.[1]
    expect(handle).toBeTruthy()
    await new Promise((r) => setTimeout(r, 300))
    const res = await tool('read_process').execute({ handle: handle! }, ctx)
    expect(res).toContain('hello')
    expect(res).toContain('exited')
  })

  it('kill_process stops a long-running command', async () => {
    const out = await tool('run_process').execute(
      { command: 'node -e "setInterval(()=>{}, 1000)"' },
      ctx,
    )
    const handle = out.match(/started (proc-\d+)/)?.[1]!
    await new Promise((r) => setTimeout(r, 100))
    const killOut = await tool('kill_process').execute({ handle }, ctx)
    expect(killOut).toContain('sent SIGTERM')
    await new Promise((r) => setTimeout(r, 200))
    expect(processManager.get(handle)?.exited).toBe(true)
  })

  it('read_process rejects an unknown handle', async () => {
    await expect(
      tool('read_process').execute({ handle: 'proc-999' }, ctx),
    ).rejects.toThrow(/unknown process handle/)
  })

  it('kill_process only accepts a named signal from its enum', () => {
    const schema = tool('kill_process').parameters
    expect(
      schema.safeParse({ handle: 'proc-1', signal: 'SIGKILL' }).success,
    ).toBe(true)
    expect(schema.safeParse({ handle: 'proc-1', signal: '9' }).success).toBe(
      false,
    )
    expect(
      schema.safeParse({ handle: 'proc-1', signal: 'SIGFOO' }).success,
    ).toBe(false)
  })

  it('kill_process rejects an unknown handle', async () => {
    await expect(
      tool('kill_process').execute({ handle: 'proc-999' }, ctx),
    ).rejects.toThrow(/unknown process handle/)
  })

  it('a background process outlives the turn that launched it, even if that turn is later aborted', async () => {
    // run_process deliberately doesn't wire ctx.signal into the spawned
    // child: it's meant to keep running across turns until kill_process (or
    // process exit), not die when the launching turn's own AbortController
    // fires — which in the REPL happens on a *later*, unrelated Ctrl-C
    // anyway, since a fresh AbortController is created per line.
    const ac = new AbortController()
    const out = await tool('run_process').execute(
      { command: 'node -e "setInterval(()=>{}, 1000)"' },
      { ...ctx, signal: ac.signal },
    )
    const handle = out.match(/started (proc-\d+)/)?.[1]!
    ac.abort()
    await new Promise((r) => setTimeout(r, 200))
    expect(processManager.get(handle)?.exited).toBe(false)
    await tool('kill_process').execute({ handle }, ctx)
  })

  it('evicts old exited processes once the map grows past the cap', async () => {
    const handles: string[] = []
    for (let i = 0; i < 50; i++) {
      const out = await tool('run_process').execute({ command: 'true' }, ctx)
      handles.push(out.match(/started (proc-\d+)/)![1]!)
    }
    await new Promise((r) => setTimeout(r, 300))
    // The 51st spawn triggers eviction of the oldest already-exited entry.
    await tool('run_process').execute({ command: 'true' }, ctx)
    expect(processManager.get(handles[0]!)).toBeUndefined()
  })
})

// Behaviors aligned with claude code / opencode (see CHANGELOG): the model
// must be told where a cut-off read resumes, edits must be safe on empty and
// CRLF input, and shell commands must never wait on a terminal nobody types at.
describe('read_file paging hints', () => {
  it('names the next offset when the output cap cuts a file short', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
    await writeFile(join(root, 'long.txt'), lines.join('\n') + '\n')
    const out = await tool('read_file').execute({ path: 'long.txt' }, ctx)
    const m = out.match(/lines 1–(\d+) of 5000; offset=(\d+) to continue/)
    expect(m).not.toBeNull()
    expect(Number(m![2])).toBe(Number(m![1]) + 1)
    expect(Buffer.byteLength(out)).toBeLessThan(ctx.config.maxToolOutputBytes)
    // Resuming at the named offset picks up exactly where it stopped.
    const next = await tool('read_file').execute(
      { path: 'long.txt', offset: Number(m![2]), limit: 1 },
      ctx,
    )
    expect(next).toContain(`${m![2]}\tline ${m![2]}`)
  })

  it('does not count the trailing newline as a line', async () => {
    await writeFile(join(root, 'n.txt'), 'a\nb\n')
    expect(await tool('read_file').execute({ path: 'n.txt' }, ctx)).toBe(
      '1\ta\n2\tb',
    )
  })

  it('shows CRLF files without carriage returns', async () => {
    await writeFile(join(root, 'w.txt'), 'a\r\nb\r\n')
    expect(await tool('read_file').execute({ path: 'w.txt' }, ctx)).toBe(
      '1\ta\n2\tb',
    )
  })

  it('caps a single very long line instead of spending the whole budget on it', async () => {
    await writeFile(join(root, 'min.js'), 'x'.repeat(20_000) + '\nnext\n')
    const out = await tool('read_file').execute({ path: 'min.js' }, ctx)
    expect(out).toContain('2\tnext')
    expect(out).toMatch(/line truncated/)
  })

  it('errors with the line count when the offset is past the end', async () => {
    await writeFile(join(root, 'n.txt'), 'a\nb\n')
    await expect(
      tool('read_file').execute({ path: 'n.txt', offset: 9 }, ctx),
    ).rejects.toThrow(/offset 9.*2 lines/)
  })

  it('lists a directory: subdirectories end in /, symlinks in @', async () => {
    await writeFile(join(root, 'b.txt'), 'x')
    await writeFile(join(root, 'a.txt'), 'x')
    await mkdir(join(root, 'sub'))
    await symlink(join(root, 'a.txt'), join(root, 'ln'))
    const out = await tool('read_file').execute({ path: '.' }, ctx)
    expect(out.split('\n')).toEqual(['a.txt', 'b.txt', 'ln@', 'sub/'])
  })

  it('pages a directory listing with the same offset/limit and hint', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, n), 'x')
    const out = await tool('read_file').execute(
      { path: '.', offset: 2, limit: 1 },
      ctx,
    )
    expect(out).toBe('b\n… (entries 2–2 of 3; offset=3 to continue)')
  })
})

describe('edit_file safety', () => {
  it('rejects an empty old_string instead of inserting between every character', async () => {
    await writeFile(join(root, 'a.txt'), 'abc')
    await expect(
      tool('edit_file').execute(
        { path: 'a.txt', old_string: '', new_string: '-', replace_all: true },
        ctx,
      ),
    ).rejects.toThrow(/empty/)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('abc')
  })

  it('rejects an edit that changes nothing', async () => {
    await writeFile(join(root, 'a.txt'), 'abc')
    await expect(
      tool('edit_file').execute(
        { path: 'a.txt', old_string: 'abc', new_string: 'abc' },
        ctx,
      ),
    ).rejects.toThrow(/identical/)
  })

  it('matches multi-line text in a CRLF file and keeps its line endings', async () => {
    await writeFile(join(root, 'w.txt'), 'one\r\ntwo\r\nthree\r\n')
    await tool('edit_file').execute(
      { path: 'w.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' },
      ctx,
    )
    expect(await readFile(join(root, 'w.txt'), 'utf8')).toBe(
      'uno\r\ndos\r\nthree\r\n',
    )
  })

  it('reports how many occurrences replace_all changed', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo foo')
    const out = await tool('edit_file').execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'x', replace_all: true },
      ctx,
    )
    expect(out).toBe('edited a.txt (3 replacements)')
  })
})

describe('run_shell against a non-interactive environment', () => {
  it('gives commands an empty stdin instead of waiting on one', async () => {
    const t0 = Date.now()
    const out = await tool('run_shell').execute(
      { command: 'cat; echo done' },
      ctx,
    )
    expect(out).toBe('done')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('keeps the end of an oversized result, where a build or test failure is reported', async () => {
    expect(tool('run_shell').keep).toBe('ends')
    const shell = tool('run_shell')
    const small = { ...ctx, config: cfg({ maxToolOutputBytes: 200 }) }
    const res = await runTool(
      {
        id: 'c1',
        name: 'run_shell',
        arguments: JSON.stringify({
          command: 'seq 1 500; echo FINAL-FAILURE; exit 2',
        }),
      },
      shell,
      small,
    )
    expect(res.ok).toBe(false)
    expect(res.output.startsWith('error: ')).toBe(true)
    expect(res.output).toContain('FINAL-FAILURE')
    expect(res.output).toContain('exit 2')
    expect(res.output).toMatch(/bytes omitted/)
  })
})

describe('edit_file size limit', () => {
  it('refuses a file too large to edit without reading it into memory', async () => {
    const path = join(root, 'big.txt')
    await writeFile(path, 'x'.repeat(9 * 1024 * 1024))
    await expect(
      tool('edit_file').execute(
        {
          path: 'big.txt',
          old_string: 'x',
          new_string: 'y',
          replace_all: true,
        },
        ctx,
      ),
    ).rejects.toThrow(/too large.*run_shell/)
    expect((await readFile(path, 'utf8'))[0]).toBe('x')
  })
})

describe('runTool truncation modes', () => {
  const emoji = (keep?: 'head' | 'ends') =>
    defineTool({
      name: 'emit',
      keep,
      description: 'test',
      parameters: z.object({}),
      execute: async () => '🙂'.repeat(200),
    })
  const run = (keep?: 'head' | 'ends') =>
    runTool({ id: 'c', name: 'emit', arguments: '{}' }, emoji(keep), {
      ...ctx,
      config: cfg({ maxToolOutputBytes: 131 }),
    })

  it('never splits a multi-byte character, whichever end it cuts', async () => {
    for (const keep of ['head', 'ends'] as const) {
      const res = await run(keep)
      expect(res.output).not.toContain('\uFFFD')
      expect(res.output).toMatch(/omitted|truncated/)
    }
  })

  it('keeps only the head by default', async () => {
    expect((await run()).output).toMatch(/output truncated to 131 bytes\]$/)
  })
})

describe('search output caps', () => {
  it('grep cuts a very long matching line', async () => {
    await writeFile(join(root, 'min.js'), `needle${'x'.repeat(5000)}\n`)
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out.length).toBeLessThan(1000)
    expect(out).toContain('min.js:1:')
  })

  it('glob defaults to a compact cap', async () => {
    for (let i = 0; i < 250; i++) await writeFile(join(root, `f${i}.txt`), '')
    const out = await tool('glob').execute({ pattern: '*.txt' }, ctx)
    expect(out).toMatch(/showing first 200 of 250/)
  })
})
