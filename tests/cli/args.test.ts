import { describe, expect, it } from 'vitest'
import { parseCli, formatFlags } from '../../src/cli/args.ts'

describe('parseCli', () => {
  it('returns defaults with no args', () => {
    const a = parseCli([])
    expect(a.prompt).toBeUndefined()
    expect(a.noColor).toBe(false)
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

  it('parses --config, --verbose, --version, --help', () => {
    const a = parseCli([
      '--config',
      './c.json',
      '--verbose',
      '--version',
      '--help',
    ])
    expect(a.config).toBe('./c.json')
    expect(a.verbose).toBe(true)
    expect(a.version).toBe(true)
    expect(a.help).toBe(true)
  })

  // Lenient parsing didn't merely ignore a typo'd flag, it was destructive:
  // `--modle gpt-4 "do a thing"` dropped the flag *and* swallowed its value
  // into the positionals, silently running the default model against the
  // prompt "gpt-4 do a thing".
  it('rejects an unknown flag instead of folding its value into the prompt', () => {
    expect(() => parseCli(['--modle', 'gpt-4', 'do a thing'])).toThrow(
      /Unknown option '--modle'/,
    )
  })

  it('still accepts a prompt beginning with a dash after `--`', () => {
    expect(parseCli(['--', '--this is a prompt']).prompt).toBe(
      '--this is a prompt',
    )
  })

  it('parses the short forms', () => {
    const a = parseCli(['-m', 'gpt-4', '-c', './c.json', 'hi'])
    expect(a.model).toBe('gpt-4')
    expect(a.config).toBe('./c.json')
    expect(a.prompt).toBe('hi')
  })
})

// --help is rendered from the same table parseCli parses with, so a flag
// can't exist without being documented. The short forms in particular were
// absent from the old hand-written help block.
describe('formatFlags', () => {
  it('documents every flag, including its short form', () => {
    const out = formatFlags()
    for (const [long, short] of [
      ['--model', '-m'],
      ['--config', '-c'],
      ['--version', '-v'],
      ['--help', '-h'],
    ]) {
      expect(out).toContain(long!)
      expect(out).toContain(short!)
    }
    expect(out).toContain('--verbose')
    expect(out).toContain('--no-color')
  })
})
