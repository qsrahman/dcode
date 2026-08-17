import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsTools } from '../../src/tools/local/fs.ts'
import { runTool } from '../../src/agent/run.ts'
import type { ToolCall, ToolContext } from '../../src/agent/types.ts'
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

  it('runTool validates args and returns a clear error on failure', async () => {
    const call: ToolCall = { id: 'c', name: 'read_file', arguments: '{}' }
    const res = await runTool(call, tool('read_file'), ctx)
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/error/)
    expect(res.output).toMatch(/path/i)
  })

  it('runTool runs successfully on valid args', async () => {
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
