import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localTools } from '../../src/tools/local.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'
import type { ToolContext } from '../../src/agent/types.ts'

const tools = localTools
function get(name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

let root: string
let ctx: ToolContext
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-mutate-'))
  ctx = { root, config: cfg(), logger: createLogger(cfg()) }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('mutate tools', () => {
  it('write_file writes content', async () => {
    const out = await get('write_file').execute(
      { path: 'a.txt', content: 'hello' },
      ctx,
    )
    expect(out).toContain('wrote')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('edit_file replaces a unique occurrence', async () => {
    await writeFile(join(root, 'a.txt'), 'foo bar baz')
    const out = await get('edit_file').execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'baz' },
      ctx,
    )
    expect(out).toContain('edited')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('baz bar baz')
  })

  it('edit_file errors when old_string is absent', async () => {
    await writeFile(join(root, 'a.txt'), 'foo')
    await expect(
      get('edit_file').execute(
        { path: 'a.txt', old_string: 'nope', new_string: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/not found/)
  })

  it('edit_file errors when old_string is ambiguous without replace_all', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo')
    await expect(
      get('edit_file').execute(
        { path: 'a.txt', old_string: 'foo', new_string: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/matches/)
  })

  it('edit_file replace_all replaces every occurrence', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo')
    await get('edit_file').execute(
      { path: 'a.txt', old_string: 'foo', new_string: 'x', replace_all: true },
      ctx,
    )
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('x x')
  })

  it('run_shell captures combined output', async () => {
    const out = await get('run_shell').execute({ command: 'echo hi' }, ctx)
    expect(out).toContain('hi')
  })

  it('run_shell preserves stdout and stderr when the command fails', async () => {
    await expect(
      get('run_shell').execute(
        { command: 'echo out; echo err 1>&2; exit 3' },
        ctx,
      ),
    ).rejects.toThrow(/exit 3: out\nerr/)
  })

  it('rejects paths that escape the working directory', async () => {
    await expect(
      get('write_file').execute({ path: '../escape.txt', content: 'x' }, ctx),
    ).rejects.toThrow(/escapes/)
  })
})
