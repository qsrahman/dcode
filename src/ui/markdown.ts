import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import { stripVTControlCharacters } from 'node:util'

// marked-terminal styles via its own internal `chalk` import, whose color
// level is decided once at module-load time from chalk's own TTY/env-var
// detection — long before `--no-color`/`config.color` is even parsed from
// argv in main(). There's no supported way to hand marked-terminal a color
// flag after the fact (its options only let you override *which* function
// renders each node type, not force plain output across the board), so
// `--no-color` can't prevent marked-terminal from generating ANSI codes in
// the first place. Instead, renderMarkdown/MarkdownStreamRenderer take an
// explicit `color` flag and strip the codes via `stripVTControlCharacters()` afterward —
// the same tool the test suite already uses for this exact operation.
marked.use(markedTerminal())

// Work around a real marked-terminal bug: its `text` renderer does
// `text = text.text` for a block-level text token — the raw, unparsed
// source string — instead of recursively rendering the token's nested
// inline tokens. A *tight* list item's content is represented as exactly
// this kind of block-level text token, so any inline markdown inside a
// list item (**bold**, *italic*, `code`) was rendered completely literally.
// Confirmed directly against marked-terminal@7.3.0's source
// (Renderer.prototype.text); registering a later extension here overrides
// it, same net effect as the patch Codex CLI carries for the same package.
marked.use({
  renderer: {
    text(token) {
      if ('tokens' in token && token.tokens?.length) {
        return this.parser.parseInline(token.tokens)
      }
      return 'text' in token ? token.text : String(token)
    },
  },
})

// Second known marked-terminal bug (github.com/mikaelbr/marked-terminal
// issue #376): `fixNestedLists()` matches indentation boundaries with a
// `\S` (non-whitespace) regex, which also matches the trailing `m` of an
// ANSI reset code (`\x1b[0m`) as if it were real content — inserting a
// spurious blank line between nested list items whenever their text carries
// any styling. Only became reachable once the `text` fix above made list
// items render inline styling at all. Not overridable via the extension
// system (`fixNestedLists` is an internal helper, not a renderer method),
// so this strips the resulting artifact post-render instead: a line that
// is non-empty but contains nothing except whitespace and ANSI escapes. A
// genuine blank separator line from marked-terminal is always the empty
// string, so this can't collide with intentional spacing.
const ANSI_RE = /\x1b\[[0-9;]*m/g
export function stripSpuriousAnsiOnlyLines(rendered: string): string {
  return rendered
    .split('\n')
    .filter((line) => line === '' || line.replace(ANSI_RE, '').trim() !== '')
    .join('\n')
}

// Render a complete markdown string to ANSI-styled text (or, when `color` is
// false, plain text with the ANSI codes stripped — see the note above on why
// they can't simply be avoided). marked-terminal's renderer is synchronous
// (no async extensions are registered), so this never returns a Promise.
export function renderMarkdown(text: string, color = true): string {
  const rendered = stripSpuriousAnsiOnlyLines(
    marked.parse(text, { async: false }),
  )
  return color ? rendered : stripVTControlCharacters(rendered)
}

function countFences(s: string): number {
  return s.match(/```/g)?.length ?? 0
}

// The largest prefix of `text` that ends at a blank-line block boundary and
// is not inside an unclosed code fence — safe to render and commit without
// it later changing meaning as more input arrives. A blank line closes every
// CommonMark block construct (paragraphs, headings, lists, blockquotes)
// except a fenced code block, which can itself contain blank lines; fence
// balance (an even number of ``` markers before the boundary) is what rules
// those out. Returns -1 if there's no safe boundary yet.
function findSafeBoundary(text: string): number {
  let searchEnd = text.length
  for (;;) {
    const idx = text.lastIndexOf('\n\n', searchEnd - 1)
    if (idx === -1) return -1
    const boundary = idx + 2
    if (countFences(text.slice(0, boundary)) % 2 === 0) return boundary
    searchEnd = idx
  }
}

// Incremental markdown-to-ANSI renderer for streamed model output. Buffers
// deltas and only emits fully-formed, block-complete lines (via
// findSafeBoundary) so a client never sees a code fence rendered before its
// closing ``` arrives — findSafeBoundary explicitly tracks fence parity for
// that. It does *not* separately track inline markers like `**bold**`: an
// unclosed `**` mid-paragraph is naturally held back too, but only because
// the enclosing paragraph hasn't reached its own `\n\n` boundary yet, not
// because of any dedicated inline-marker logic — and CommonMark emphasis
// spans never cross a block boundary anyway, so once a block *is* judged
// complete, any `**` within it is already exactly as balanced (or not) as
// it will ever be. This mirrors the "newline-gated" streaming pattern used
// by Codex CLI's Rust TUI (render only committed lines; the unstable tail
// waits) rather than either printing raw deltas or buffering the whole turn
// silently until it ends.
export class MarkdownStreamRenderer {
  private buffer = ''
  private committedLineCount = 0
  // Mirrors config.color/--no-color; see renderMarkdown for why this has to
  // be a post-render strip rather than preventing the codes upstream.
  private color: boolean

  constructor(color = true) {
    this.color = color
  }

  // Feed the next delta; returns newly-renderable lines (or '' if nothing
  // has crossed a safe boundary yet).
  push(delta: string): string {
    this.buffer += delta
    const boundary = findSafeBoundary(this.buffer)
    if (boundary === -1) return ''
    return this.commit(this.buffer.slice(0, boundary))
  }

  // Flush whatever remains at the end of the stream (including content
  // inside an unclosed fence, if the response ended mid-block) and reset
  // state so the instance can be reused for the next turn.
  finalize(): string {
    const rest = this.buffer.endsWith('\n') ? this.buffer : `${this.buffer}\n`
    const out = this.commit(rest)
    this.buffer = ''
    this.committedLineCount = 0
    return out
  }

  // Re-render `source` from the start and return only the lines beyond what
  // was already emitted. Re-rendering the whole safe prefix each time
  // (rather than trying to render only the new fragment) is what lets
  // marked-terminal correctly handle constructs that depend on later
  // context within the same block (e.g. list continuation).
  private commit(source: string): string {
    const lines = renderMarkdown(source, this.color).split('\n')
    // marked-terminal trails a block with one or more blank lines; strip all
    // of them (not just one) since the join below adds back exactly one.
    // Blank lines *between* blocks (mid-array) are real spacing and stay.
    while (lines.at(-1) === '') lines.pop()
    if (lines.length <= this.committedLineCount) return ''
    const fresh = lines.slice(this.committedLineCount)
    this.committedLineCount = lines.length
    return `${fresh.join('\n')}\n`
  }
}
