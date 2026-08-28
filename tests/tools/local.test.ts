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
  listDirTool,
  statTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  copyFileTool,
  deleteFileTool,
  makeDirTool,
} from '../../src/tools/local/fs.ts'
import { grepTool, globTool } from '../../src/tools/local/search.ts'
import { runShellTool } from '../../src/tools/local/shell.ts'
import { gitTool } from '../../src/tools/local/git.ts'
import {
  runProcessTool,
  readProcessTool,
  killProcessTool,
  processManager,
} from '../../src/tools/local/process.ts'
import type { ToolDefinition } from '../../src/agent/types.ts'
import { runTool } from '../../src/agent/run.ts'
import type { ToolCall, ToolContext } from '../../src/agent/types.ts'
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
  listDirTool(),
  grepTool(),
  statTool(),
  globTool(),
  writeFileTool(),
  editFileTool(),
  moveFileTool(),
  copyFileTool(),
  deleteFileTool(),
  makeDirTool(),
  runShellTool(),
  runProcessTool(),
  readProcessTool(),
  killProcessTool(),
  gitTool(),
]

function tool(name: string) {
  const t = localTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

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
    expect(out).toBe('2\tb\n3\tc')
  })

  it('read_file paging past the read window errors instead of implying EOF', async () => {
    // No newlines, so the whole file is one "line" within the 8 MiB paging
    // window; offset 1 asks for a line past what was read, not past the
    // file's actual end.
    await writeFile(join(root, 'big.txt'), 'x'.repeat(9 * 1024 * 1024))
    await expect(
      tool('read_file').execute({ path: 'big.txt', offset: 1 }, ctx),
    ).rejects.toThrow(/beyond the \d+-byte read window/)
  })

  it('read_file can disable line numbers', async () => {
    await writeFile(join(root, 'n.txt'), 'a\nb')
    const out = await tool('read_file').execute(
      { path: 'n.txt', line_numbers: false },
      ctx,
    )
    expect(out).toBe('a\nb')
  })

  it('list_dir lists entries', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    await mkdir(join(root, 'sub'))
    const out = await tool('list_dir').execute({}, ctx)
    expect(out).toContain('a.txt')
    expect(out).toContain('sub')
  })

  it('list_dir marks symlinks with l and sorts directories first', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    await mkdir(join(root, 'sub'))
    await symlink(join(root, 'a.txt'), join(root, 'link'))
    const out = await tool('list_dir').execute({}, ctx)
    expect(out).toContain('l link')
    expect(out).toContain('d sub')
    expect(out).toContain('f a.txt')
    // 'sub' (directory) should appear before 'a.txt' (file).
    expect(out.indexOf('sub')).toBeLessThan(out.indexOf('a.txt'))
  })

  it('grep finds matching lines', async () => {
    await writeFile(join(root, 'a.txt'), 'foo bar\nbaz\n')
    const out = await tool('grep').execute({ pattern: 'bar' }, ctx)
    expect(out).toContain('a.txt:1: foo bar')
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

  it('grep skips files above the size guard, with a note', async () => {
    await writeFile(join(root, 'big.txt'), 'needle\n'.repeat(800_000))
    await writeFile(join(root, 'small.txt'), 'needle')
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out).toContain('small.txt')
    expect(out).not.toContain('big.txt')
    expect(out).toMatch(/files larger than \d+ bytes were skipped/)
  })

  // A pathological pattern could backtrack catastrophically on a long line and
  // hang the process (regex execution is synchronous); bounding line length
  // bounds the worst case instead.
  it('grep skips matching against lines longer than the length guard', async () => {
    await writeFile(join(root, 'a.txt'), 'x'.repeat(20_000) + 'needle')
    const out = await tool('grep').execute({ pattern: 'needle' }, ctx)
    expect(out).toBe('(no matches)')
  })

  it('grep caps total matches with a note', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `m${i}`).join('\n')
    await writeFile(join(root, 'big.txt'), lines)
    const out = await tool('grep').execute({ pattern: 'm' }, ctx)
    const hits = out.split('\n').filter((l) => l.startsWith('big.txt'))
    expect(hits.length).toBe(200)
    expect(out).toMatch(/stopped at 200 matches/)
  })

  it('stat reports a file type/size/mtime', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    const out = await tool('stat').execute({ path: 'a.txt' }, ctx)
    expect(out).toContain('type: file')
    expect(out).toContain('size: 5 bytes')
    expect(out).toMatch(/modified: \d{4}-\d{2}-\d{2}T/)
  })

  it('stat reports a directory and defaults to root', async () => {
    const out = await tool('stat').execute({}, ctx)
    expect(out).toContain('type: directory')
  })

  it('stat reports a missing path clearly', async () => {
    await expect(tool('stat').execute({ path: 'nope' }, ctx)).rejects.toThrow(
      /no such file or directory/,
    )
  })

  it('stat reports line count for small text files', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree')
    const out = await tool('stat').execute({ path: 'a.txt' }, ctx)
    expect(out).toContain('lines: 3')
  })

  it('stat reports a symlink target', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    await symlink(join(root, 'a.txt'), join(root, 'link'))
    const out = await tool('stat').execute({ path: 'link' }, ctx)
    expect(out).toContain('type: file')
    expect(out).toMatch(/target:/)
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

  it('glob accepts multiple patterns', async () => {
    await writeFile(join(root, 'a.ts'), 'x')
    await writeFile(join(root, 'b.js'), 'x')
    await writeFile(join(root, 'c.md'), 'x')
    const out = await tool('glob').execute(
      { pattern: ['**/*.ts', '**/*.js'] },
      ctx,
    )
    expect(out).toContain('a.ts')
    expect(out).toContain('b.js')
    expect(out).not.toContain('c.md')
  })

  it('read_file reports a missing file clearly', async () => {
    await expect(
      tool('read_file').execute({ path: 'nope.txt' }, ctx),
    ).rejects.toThrow(/no such file or directory/)
  })

  it('read_file reports directories clearly', async () => {
    await mkdir(join(root, 'sub'))
    await expect(
      tool('read_file').execute({ path: 'sub' }, ctx),
    ).rejects.toThrow(/is a directory/)
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

  it('read_file truncates content past the output cap', async () => {
    const big = 'x'.repeat(ctx.config.maxToolOutputBytes + 500)
    await writeFile(join(root, 'big.txt'), big)
    const out = await tool('read_file').execute({ path: 'big.txt' }, ctx)
    expect(out).toMatch(/truncated at/)
    expect(out.length).toBeLessThanOrEqual(ctx.config.maxToolOutputBytes + 200)
    expect(out).not.toContain(big)
  })

  it('list_dir reports non-directories clearly', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    await expect(
      tool('list_dir').execute({ path: 'a.txt' }, ctx),
    ).rejects.toThrow(/not a directory/)
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
    expect(out).toContain('a.txt:1: x')
    expect(out).toContain('a.txt:2: MATCH')
    expect(out).toContain('a.txt:3: y')
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

  it('write_file refuses to overwrite without overwrite: true', async () => {
    await writeFile(join(root, 'a.txt'), 'old')
    await expect(
      tool('write_file').execute(
        { path: 'a.txt', content: 'new', overwrite: false },
        ctx,
      ),
    ).rejects.toThrow(/already exists/)
  })

  it('write_file overwrites when overwrite: true', async () => {
    await writeFile(join(root, 'a.txt'), 'old')
    const out = await tool('write_file').execute(
      { path: 'a.txt', content: 'new', overwrite: true },
      ctx,
    )
    expect(out).toContain('overwrote existing')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  it('write_file appends with append: true', async () => {
    await writeFile(join(root, 'a.txt'), 'old')
    const out = await tool('write_file').execute(
      { path: 'a.txt', content: 'new', append: true },
      ctx,
    )
    expect(out).toContain('appended')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('oldnew')
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

  it('run_shell labels timeouts by code rather than exit', async () => {
    const fast = { ...ctx, config: cfg({ toolTimeout: 150 }) }
    await expect(
      tool('run_shell').execute({ command: 'sleep 0.7' }, fast),
    ).rejects.toThrow(/timed out|aborted|ABORT_ERR|ETIMEDOUT/)
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
})

describe('file lifecycle tools', () => {
  it('make_dir creates nested directories', async () => {
    const out = await tool('make_dir').execute({ path: 'a/b/c' }, ctx)
    expect(out).toContain('created directory')
    await expect(access(join(root, 'a/b/c'))).resolves.toBeUndefined()
  })

  it('make_dir rejects escapes', async () => {
    await expect(
      tool('make_dir').execute({ path: '../outside' }, ctx),
    ).rejects.toThrow(/escapes/)
  })

  it('move_file moves a file and creates the destination parent', async () => {
    await writeFile(join(root, 'src.txt'), 'data')
    const out = await tool('move_file').execute(
      { source: 'src.txt', destination: 'nested/dst.txt' },
      ctx,
    )
    expect(out).toContain('moved')
    expect(await readFile(join(root, 'nested/dst.txt'), 'utf8')).toBe('data')
    await expect(readFile(join(root, 'src.txt'))).rejects.toThrow()
  })

  it('move_file moves a directory', async () => {
    await mkdir(join(root, 'd'), { recursive: true })
    await writeFile(join(root, 'd/x.txt'), 'x')
    await tool('move_file').execute({ source: 'd', destination: 'e' }, ctx)
    expect(await readFile(join(root, 'e/x.txt'), 'utf8')).toBe('x')
  })

  it('copy_file copies content and creates the destination parent', async () => {
    await writeFile(join(root, 'a.txt'), 'hi')
    const out = await tool('copy_file').execute(
      { source: 'a.txt', destination: 'sub/b.txt' },
      ctx,
    )
    expect(out).toContain('copied')
    expect(await readFile(join(root, 'sub/b.txt'), 'utf8')).toBe('hi')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hi')
  })

  it('copy_file rejects escapes', async () => {
    await writeFile(join(root, 'a.txt'), 'hi')
    await expect(
      tool('copy_file').execute(
        { source: 'a.txt', destination: '../out.txt' },
        ctx,
      ),
    ).rejects.toThrow(/escapes/)
  })

  it('delete_file removes a file', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    const out = await tool('delete_file').execute({ path: 'a.txt' }, ctx)
    expect(out).toContain('deleted')
    await expect(readFile(join(root, 'a.txt'))).rejects.toThrow()
  })

  it('delete_file removes a directory recursively', async () => {
    await mkdir(join(root, 'd'), { recursive: true })
    await writeFile(join(root, 'd/a.txt'), 'x')
    await tool('delete_file').execute({ path: 'd', recursive: true }, ctx)
    await expect(access(join(root, 'd'))).rejects.toThrow()
  })

  it('delete_file refuses to delete the working directory root', async () => {
    await expect(
      tool('delete_file').execute({ path: '.' }, ctx),
    ).rejects.toThrow(/refusing to delete/)
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

  it('kill_process rejects an unknown handle', async () => {
    await expect(
      tool('kill_process').execute({ handle: 'proc-999' }, ctx),
    ).rejects.toThrow(/unknown process handle/)
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
