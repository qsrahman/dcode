import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsTools } from '../../src/tools/local/fs.ts'
import type { ToolContext } from '../../src/agent/types.ts'
import { cfg } from '../helpers.ts'
import { createLogger } from '../../src/util/log.ts'

describe('fs tools', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dcode-fs-'))
    ctx = { root, config: cfg(), logger: createLogger(cfg()) }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function tool(name: string) {
    return createFsTools().find((t) => t.name === name)!
  }

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
})
