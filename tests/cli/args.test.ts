import { describe, expect, it } from 'vitest'
import { parseCli } from '../../src/cli/args.ts'

describe('parseCli', () => {
  it('returns defaults with no args', () => {
    const a = parseCli([])
    expect(a.prompt).toBeUndefined()
    expect(a.noColor).toBe(false)
    expect(a.auto).toBe(false)
    expect(a.plan).toBe(false)
    expect(a.verbose).toBe(false)
    expect(a.version).toBe(false)
    expect(a.help).toBe(false)
  })

  it('captures a single positional prompt', () => {
    expect(parseCli(['hello world']).prompt).toBe('hello world')
  })

  it('joins multiple positionals with a space', () => {
    expect(parseCli(['add', 'a', 'flag']).prompt).toBe('add a flag')
  })

  it('parses --model (and -m shorthand)', () => {
    expect(parseCli(['--model', 'gpt-4.1']).model).toBe('gpt-4.1')
    expect(parseCli(['-m', 'gpt-4.1']).model).toBe('gpt-4.1')
  })

  it('parses --no-color', () => {
    expect(parseCli(['--no-color']).noColor).toBe(true)
  })

  it('parses --auto and --plan shorthands', () => {
    expect(parseCli(['--auto']).auto).toBe(true)
    expect(parseCli(['--plan']).plan).toBe(true)
  })

  it('parses --mode, --config, --verbose, --version, --help', () => {
    const a = parseCli([
      '--mode',
      'plan',
      '--config',
      './c.json',
      '--verbose',
      '--version',
      '--help',
    ])
    expect(a.mode).toBe('plan')
    expect(a.config).toBe('./c.json')
    expect(a.verbose).toBe(true)
    expect(a.version).toBe(true)
    expect(a.help).toBe(true)
  })
})
