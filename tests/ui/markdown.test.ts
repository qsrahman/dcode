import { describe, expect, it } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import {
  renderMarkdown,
  MarkdownStreamRenderer,
  stripSpuriousAnsiOnlyLines,
} from '../../src/ui/markdown.ts'

describe('renderMarkdown', () => {
  it('strips markdown syntax from bold text (marked-terminal keeps a leading # on headings as a plain-text hierarchy cue)', () => {
    const out = stripVTControlCharacters(
      renderMarkdown('# Title\n\nSome **bold** text.\n'),
    )
    expect(out).toContain('Title')
    expect(out).toContain('bold')
    expect(out).not.toContain('**')
  })

  // Regression: marked-terminal@7.3.0's `text` renderer returns the raw,
  // unparsed source string for a block-level text token instead of
  // rendering its nested inline tokens — and a *tight* list item's content
  // is represented as exactly this kind of token, so **bold**/*italic*/
  // `code` inside list items rendered completely literally. Fixed with a
  // `marked.use({renderer: {text}})` override in ui/markdown.ts.
  it('renders inline markdown inside list items, not literally', () => {
    const out = stripVTControlCharacters(
      renderMarkdown('- **one**: first item\n- **two**: second item\n'),
    )
    expect(out).toContain('one')
    expect(out).toContain('two')
    expect(out).not.toContain('**')
  })

  it('renders inline markdown inside a blockquote', () => {
    const out = stripVTControlCharacters(
      renderMarkdown('> A quote with **bold** text.\n'),
    )
    expect(out).toContain('bold')
    expect(out).not.toContain('**')
  })

  // The bug this guards against: marked-terminal decides its own color
  // level from chalk's TTY/env-var auto-detection at import time, well
  // before --no-color/config.color is parsed — so on a real TTY it kept
  // emitting ANSI regardless of --no-color. renderMarkdown(text, false) must
  // strip every code it produces, not just avoid adding new ones.
  it('emits no ANSI codes at all when color is false', () => {
    const out = renderMarkdown('# Title\n\nSome **bold** text.\n', false)
    expect(out).toBe(stripVTControlCharacters(out))
    expect(out).toContain('Title')
    expect(out).toContain('bold')
  })
})

// Regression: marked-terminal@7.3.0's fixNestedLists() matches indentation
// boundaries with a `\S` (non-whitespace) regex, which also matches the
// trailing `m` of an ANSI reset code (`\x1b[0m`) — inserting a spurious
// blank line between nested list items whenever their text carries any
// styling (github.com/mikaelbr/marked-terminal issue #376). Tested directly
// against the helper (not through a real colorized render) since chalk's
// color-support detection is decided once at import time and won't respond
// to forcing color from within a test.
describe('stripSpuriousAnsiOnlyLines', () => {
  const ESC = '\x1b'

  it('removes a line containing only whitespace and ANSI escapes', () => {
    const input = `line one\n  ${ESC}[0m\nline two`
    const out = stripSpuriousAnsiOnlyLines(input)
    expect(out.split('\n')).not.toContain(`  ${ESC}[0m`)
    expect(out).toContain('line one')
    expect(out).toContain('line two')
  })

  it('preserves genuine blank lines (the empty string)', () => {
    const input = `line one\n\nline two`
    const out = stripSpuriousAnsiOnlyLines(input)
    expect(out.split('\n')).toContain('')
    expect(out).toBe(input)
  })

  it('keeps a line that has visible content alongside ANSI codes', () => {
    const input = `${ESC}[1mbold${ESC}[22m text`
    expect(stripSpuriousAnsiOnlyLines(input)).toBe(input)
  })
})

describe('MarkdownStreamRenderer', () => {
  it('round-trips plain, unformatted text delivered in small chunks', () => {
    const md = new MarkdownStreamRenderer()
    const text = 'hello there, this is plain text with no markdown.'
    let out = ''
    for (let i = 0; i < text.length; i += 3) {
      out += md.push(text.slice(i, i + 3))
    }
    out += md.finalize()
    expect(stripVTControlCharacters(out).trim()).toBe(text)
  })

  // The core streaming guarantee: a fenced code block must never be rendered
  // (even partially) before its closing fence arrives, since intermediate
  // renders of an unclosed fence would be visually broken.
  it('holds back a fenced code block until it closes', () => {
    const md = new MarkdownStreamRenderer()
    const before = 'Here is some code:\n\n'
    const fenceOpen = '```js\n'
    const codeLines = 'const x = 1;\nconsole.log(x);\n'
    const fenceClose = '```\n\n'
    const after = 'That was the code.\n\n'

    let committed = ''
    // Feed everything up to (but not including) the closing fence, one
    // character at a time — the code block's content must never surface.
    const upToClose = before + fenceOpen + codeLines
    for (const ch of upToClose) {
      committed += md.push(ch)
    }
    const strippedSoFar = stripVTControlCharacters(committed)
    expect(strippedSoFar).toContain('Here is some code')
    expect(strippedSoFar).not.toContain('const x')
    expect(strippedSoFar).not.toContain('console.log')

    // Closing the fence (plus the following blank line that ends the block)
    // should now release the code block's content.
    committed += md.push(fenceClose)
    committed += md.push(after)
    committed += md.finalize()
    const full = stripVTControlCharacters(committed)
    expect(full).toContain('const x')
    expect(full).toContain('console.log')
    expect(full).toContain('That was the code')
  })

  it('finalize flushes a trailing paragraph with no closing blank line', () => {
    const md = new MarkdownStreamRenderer()
    let out = md.push('An unterminated paragraph with no trailing blank line')
    expect(out).toBe('')
    out += md.finalize()
    expect(stripVTControlCharacters(out)).toContain(
      'An unterminated paragraph with no trailing blank line',
    )
  })

  it('never emits the same line twice across multiple push calls', () => {
    const md = new MarkdownStreamRenderer()
    const parts = [
      'First paragraph.\n\n',
      'Second paragraph.\n\n',
      'Third paragraph.\n\n',
    ]
    let out = ''
    for (const p of parts) out += md.push(p)
    out += md.finalize()
    const plain = stripVTControlCharacters(out)
    expect(plain.match(/First paragraph\./g)).toHaveLength(1)
    expect(plain.match(/Second paragraph\./g)).toHaveLength(1)
    expect(plain.match(/Third paragraph\./g)).toHaveLength(1)
  })

  it('reuses the instance cleanly across turns after finalize', () => {
    const md = new MarkdownStreamRenderer()
    md.push('First turn text.\n\n')
    md.finalize()
    let out = md.push('Second turn text.\n\n')
    out += md.finalize()
    const plain = stripVTControlCharacters(out)
    expect(plain).toContain('Second turn text')
    expect(plain).not.toContain('First turn text')
  })

  it('emits no ANSI codes when constructed with color: false', () => {
    const md = new MarkdownStreamRenderer(false)
    let out = md.push('Some **bold** text.\n\n')
    out += md.finalize()
    expect(out).toBe(stripVTControlCharacters(out))
    expect(out).toContain('bold')
  })
})
