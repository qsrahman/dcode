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
import { localTools } from '../../src/tools/local/index.ts'
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
  await rm(root, { recursive: true, force: true })
})

function tool(name: string) {
  const t = localTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

describe('read-only tools', () => {
  it('read_file returns file contents and rejects escapes', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    const out = await tool('read_file').execute({ path: 'a.txt' }, ctx)
    expect(out).toBe('hello')
    await expect(
      tool('read_file').execute({ path: '../evil' }, ctx),
    ).rejects.toThrow(/escapes/)
  })

  it('list_dir lists entries', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    await mkdir(join(root, 'sub'))
    const out = await tool('list_dir').execute({}, ctx)
    expect(out).toContain('a.txt')
    expect(out).toContain('sub')
  })

  it('grep finds matching lines', async () => {
    await writeFile(join(root, 'a.txt'), 'foo bar\nbaz\n')
    const out = await tool('grep').execute({ pattern: 'bar' }, ctx)
    expect(out).toContain('a.txt:1: foo bar')
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

  it('run_shell captures combined output', async () => {
    const out = await tool('run_shell').execute({ command: 'echo hi' }, ctx)
    expect(out).toContain('hi')
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
      'inside',
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
    expect(res.output).toBe('hi')
  })
})
